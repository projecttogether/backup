package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Client speaks the agent protocol, version 1 (README.md, "Protocol"), with
// the Backup app.
type Client struct {
	base      string // BACKUP_URL + /api/agent/v1
	token     string
	userAgent string
	http      *http.Client
	log       *slog.Logger
	// sleep waits between attempts; tests replace it.
	sleep    func(ctx context.Context, d time.Duration) error
	attempts int // per part, and for /complete
}

const (
	callTimeout = time.Minute
	// partTimeout: the Backup app answers a part only after restic took it.
	partTimeout  = 10 * time.Minute
	partAttempts = 10
	failAttempts = 3
)

var (
	errUnauthorized = errors.New("The Backup app refused the token (HTTP 401): check BACKUP_TOKEN, and that the source still exists in the Backup app")
	errJobEnded     = errors.New("The Backup app ended the job (HTTP 410)")
)

// apiError is an answer of the Backup app other than the expected one.
type apiError struct {
	Status   int
	Code     string
	Message  string
	Expected *int // 409 out_of_order: the part the Backup app expects
}

func (e *apiError) Error() string {
	text := fmt.Sprintf("The Backup app answered HTTP %d", e.Status)
	if e.Code != "" {
		text += " (" + e.Code + ")"
	}
	if e.Message != "" {
		text += ": " + e.Message
	}
	return text
}

func parseError(status int, data []byte) *apiError {
	var body struct {
		Error struct {
			Code     string `json:"code"`
			Message  string `json:"message"`
			Expected *int   `json:"expected"`
		} `json:"error"`
		Expected *int `json:"expected"`
	}
	_ = json.Unmarshal(data, &body)
	e := &apiError{Status: status, Code: body.Error.Code, Message: body.Error.Message, Expected: body.Error.Expected}
	if e.Expected == nil {
		e.Expected = body.Expected
	}
	if len(e.Message) > 300 {
		e.Message = e.Message[:300]
	}
	return e
}

func retryable(status int) bool {
	return status >= 500 || status == http.StatusTooManyRequests || status == http.StatusRequestTimeout
}

func newClient(cfg Config, log *slog.Logger) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &Client{
		base:      cfg.URL + "/api/agent/v1",
		token:     cfg.Token,
		userAgent: userAgent(cfg.Version),
		http: &http.Client{
			Transport: transport,
			// The token travels with every request: never to another address.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		log:      log,
		sleep:    sleepContext,
		attempts: partAttempts,
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// backoff is the wait after the given failed attempt: 1 s, 2 s, 4 s … 60 s.
func backoff(attempt int) time.Duration {
	if attempt >= 7 {
		return time.Minute
	}
	return min(time.Second<<(attempt-1), time.Minute)
}

// send makes one request and reads the answer (at most 1 MiB).
func (c *Client) send(ctx context.Context, timeout time.Duration, method, path string, body []byte, contentType string, header map[string]string) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("User-Agent", c.userAgent)
	request.Header.Set("Content-Type", contentType)
	for name, value := range header {
		request.Header.Set(name, value)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, nil, err
	}
	return response.StatusCode, data, nil
}

func (c *Client) sendJSON(ctx context.Context, timeout time.Duration, path string, value any) (int, []byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return 0, nil, err
	}
	return c.send(ctx, timeout, http.MethodPost, path, body, "application/json", nil)
}

// withRetries calls try until it succeeds, fails for good (retry false), or
// failed attempts times, waiting backoff between the attempts.
func (c *Client) withRetries(ctx context.Context, attempts int, what string, attrs []any, try func() (retry bool, err error)) error {
	for attempt := 1; ; attempt++ {
		retry, err := try()
		if err == nil || !retry {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt >= attempts {
			return fmt.Errorf("%s failed %d times; the last time: %w", what, attempt, err)
		}
		wait := backoff(attempt)
		c.log.Warn("Sending "+what+" failed; trying again.", append(attrs, "attempt", attempt, "wait", wait, "error", err)...)
		if err := c.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// PollRequest is the body of POST /poll.
type PollRequest struct {
	Agent    AgentInfo `json:"agent"`
	App      AppInfo   `json:"app"`
	Database bool      `json:"database"`
	Volumes  []string  `json:"volumes"`
	// Check: the check command asks; the Backup app hands out no job.
	Check bool `json:"check,omitempty"`
}

// PollAnswer is the answer to POST /poll.
type PollAnswer struct {
	Source      Source `json:"source"`
	PollSeconds int    `json:"pollSeconds"`
	Job         *Job   `json:"job"`
}

type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Job struct {
	ID        string `json:"id"`
	PartBytes int64  `json:"partBytes"`
}

// Poll is the heartbeat and job pickup: one attempt.
func (c *Client) Poll(ctx context.Context, request PollRequest) (PollAnswer, error) {
	var answer PollAnswer
	status, data, err := c.sendJSON(ctx, callTimeout, "/poll", request)
	switch {
	case err != nil:
		return answer, err
	case status == http.StatusUnauthorized:
		return answer, errUnauthorized
	case status != http.StatusOK:
		return answer, parseError(status, data)
	}
	if err := json.Unmarshal(data, &answer); err != nil {
		return answer, fmt.Errorf("The Backup app answered the poll with something other than its JSON: %w", err)
	}
	return answer, nil
}

func jobPath(jobID string) string { return "/jobs/" + url.PathEscape(jobID) }

// PutPart sends part n of the stream, with retries: network errors, 5xx
// and 422 (damaged on the way) are sent again, the same part with the same
// checksum. 409 that expects the next part means the Backup app has this one.
func (c *Client) PutPart(ctx context.Context, jobID string, n int, data []byte, sha string) error {
	path := jobPath(jobID) + "/parts/" + strconv.Itoa(n)
	header := map[string]string{"X-Part-Sha256": sha}
	attrs := []any{"job", jobID, "part", n}
	return c.withRetries(ctx, c.attempts, "part "+strconv.Itoa(n), attrs, func() (bool, error) {
		status, body, err := c.send(ctx, partTimeout, http.MethodPut, path, data, "application/octet-stream", header)
		switch {
		case err != nil:
			return ctx.Err() == nil, err
		case status >= 200 && status < 300:
			return false, nil
		case status == http.StatusUnauthorized:
			return false, errUnauthorized
		case status == http.StatusGone:
			return false, errJobEnded
		}
		e := parseError(status, body)
		switch {
		case status == http.StatusConflict && e.Expected != nil && *e.Expected == n+1:
			c.log.Debug("The Backup app already has the part.", attrs...)
			return false, nil
		case status == http.StatusConflict && e.Expected != nil:
			return false, fmt.Errorf("The Backup app expected part %d, the agent sent part %d", *e.Expected, n)
		case status == http.StatusUnprocessableEntity:
			return true, e // checksum_mismatch: send it again
		}
		return retryable(status), e
	})
}

// Complete reports the totals of the stream. Network errors and 5xx are
// tried again, like parts.
func (c *Client) Complete(ctx context.Context, jobID string, totals Totals) error {
	tried := false
	return c.withRetries(ctx, c.attempts, "the totals", []any{"job", jobID}, func() (bool, error) {
		again := tried
		tried = true
		status, body, err := c.sendJSON(ctx, callTimeout, jobPath(jobID)+"/complete", totals)
		switch {
		case err != nil:
			return ctx.Err() == nil, err
		case status >= 200 && status < 300:
			return false, nil
		case status == http.StatusUnauthorized:
			return false, errUnauthorized
		case status == http.StatusGone && again:
			return false, fmt.Errorf("%w; an earlier attempt to send the totals may have reached it", errJobEnded)
		case status == http.StatusGone:
			return false, errJobEnded
		}
		e := parseError(status, body)
		return retryable(status), e
	})
}

// Fail reports that the agent could not produce the stream. A job that
// already ended (410) needs no report.
func (c *Client) Fail(ctx context.Context, jobID, message string) error {
	return c.withRetries(ctx, failAttempts, "the failure report", []any{"job", jobID}, func() (bool, error) {
		status, body, err := c.sendJSON(ctx, callTimeout, jobPath(jobID)+"/fail", map[string]string{"message": message})
		switch {
		case err != nil:
			return ctx.Err() == nil, err
		case status >= 200 && status < 300, status == http.StatusGone:
			return false, nil
		case status == http.StatusUnauthorized:
			return false, errUnauthorized
		}
		return retryable(status), parseError(status, body)
	})
}

// Progress tells the Backup app that the job is alive while pg_dump runs, before
// the first part: stage "database" and the bytes of the dump so far. One
// attempt; a Backup app without this endpoint (404) is no error.
func (c *Client) Progress(ctx context.Context, jobID, stage string, bytes int64) error {
	status, body, err := c.sendJSON(ctx, callTimeout, jobPath(jobID)+"/progress", map[string]any{"stage": stage, "bytes": bytes})
	switch {
	case err != nil:
		return err
	case status >= 200 && status < 300, status == http.StatusNotFound:
		return nil
	case status == http.StatusUnauthorized:
		return errUnauthorized
	case status == http.StatusGone:
		return errJobEnded
	}
	return parseError(status, body)
}
