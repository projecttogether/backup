import { defineMessages } from "@/i18n";

export const messages = defineMessages({
  en: {
    title: "Target",
    description:
      "Where every backup goes: one encrypted restic repository in an S3-compatible bucket, e.g. Hetzner Object Storage.",
    // Bucket form
    bucketTitle: "Bucket",
    bucketDescription: "The address and keys of the bucket. Keys need read and write access to it.",
    endpoint: "Endpoint",
    endpointHint: "For Hetzner Object Storage: https://<location>.your-objectstorage.com",
    region: "Region",
    regionHint: "e.g. fsn1. Some providers need it.",
    bucket: "Bucket name",
    prefix: "Folder in the bucket",
    prefixHint: "Optional. Empty: the bucket's root.",
    accessKey: "Access key",
    secretKey: "Secret key",
    save: "Save",
    saved: "Saved",
    checkFields: "Check the highlighted fields.",
    // Repository
    repositoryTitle: "Repository",
    repositoryDescription:
      "The restic repository that holds the snapshots of all sources, encrypted with its password.",
    notConfigured: "Save the bucket first.",
    address: "Address",
    state: "State",
    stateUnknown: "Not checked yet",
    stateMissing: "No repository yet",
    stateReady: "Ready",
    stateWrongPassword: "Wrong password",
    stateError: "Cannot reach the bucket",
    unknownHint: "Test the connection to see whether a repository is there.",
    testConnection: "Test connection",
    tested: "Connection tested",
    missingHint:
      "There is no repository at this address yet. Create one, or connect to a repository that already exists there.",
    create: "Create repository",
    createTitle: "Create the repository?",
    createText:
      "The app generates a strong password and creates an encrypted repository at this address. Download the recovery kit right after and store it offline: without the password, nobody can restore the backups.",
    created: "Repository created. Download the recovery kit now.",
    connect: "Connect to an existing repository",
    connectTitle: "Connect to an existing repository",
    connectText: "Enter the repository's password. The app stores it and uses it for all backups.",
    password: "Repository password",
    connectButton: "Connect",
    connected: "Connected",
    wrongPasswordHint:
      "A repository is there, but the stored password does not open it. Enter the repository's password.",
    readyHint: "The repository is ready. Backups go here.",
    // Recovery kit
    kitTitle: "Recovery kit",
    kitText:
      "The recovery kit holds the bucket's address, its keys and the repository password. With it, the plain restic command line restores everything, even without this app. Store it offline, e.g. in a password manager or a safe.",
    kitDownload: "Download recovery kit",
    kitConfirm: "I stored the recovery kit",
    kitConfirmed: "Thank you. The dashboard no longer asks for it.",
    kitStored: "Stored",
    kitConfirmedAt: "Confirmed",
    kitNotStored: "Not stored yet",
    kitNoPassword: "The recovery kit is ready once the repository is created or connected.",
    // Protection
    protectionTitle: "Bucket protection",
    protectionDescription:
      "What the bucket's settings do against deleted or encrypted data, read with the S3 API.",
    protectionUnknown: "Not read yet. Test the connection to read the bucket's settings.",
    unknown: "Unknown",
    on: "On",
    off: "Off",
    versioning: "Versioning",
    versioningSuspended: "Suspended",
    versioningTip: "Turn on versioning, so that deleted or overwritten data stays restorable for a while.",
    objectLock: "Object Lock",
    objectLockMode: "{mode}, {days} days",
    objectLockTip:
      "Object Lock must be enabled when the bucket is created. It keeps data from being deleted, even with the bucket's keys. To use it, create a new bucket with Object Lock and move the target there.",
    governanceNote:
      "In governance mode, a key with the bypass permission can delete locked data early. Compliance mode lets nobody do that.",
    lifecycle: "Lifecycle rules",
    noncurrent: "Old versions deleted after {days} days",
    noncurrentMissing: "Old versions are never deleted",
    deleteMarkers: "Expired delete markers removed",
    deleteMarkersMissing: "Expired delete markers stay",
    multipart: "Incomplete uploads removed after {days} days",
    multipartMissing: "Incomplete uploads stay",
    lifecycleTip:
      "Lifecycle rules clean up what restic deletes: old versions 31 days later, leftover delete markers, and incomplete uploads after 7 days. Set them through the S3 API, for example with the AWS command line, with the bucket's keys in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. This replaces the bucket's current lifecycle rules.",
    protectionError: "Some settings could not be read: {message}",
    // Stats
    statsTitle: "Repository",
    storedBytes: "Stored in the bucket",
    snapshots: "Snapshots",
    lastCheck: "Last integrity check",
    checkOk: "Passed",
    checkFailed: "Failed",
    readData: "Read and verified {share} of the data",
    structureOnly: "Structure only",
    never: "Not yet",
    // Upkeep
    upkeepTitle: "Upkeep",
    upkeepDescription:
      "Every day the app applies each source's retention, removes data no snapshot needs, checks the repository's integrity and backs up its own database.",
    upkeepTime: "Daily at",
    upkeepTimeHint: "Server time, {zone}.",
    saveTime: "Save time",
    runUpkeep: "Run upkeep now",
    upkeepStarted: "Upkeep started",
    viewRun: "View run",
  },
});
