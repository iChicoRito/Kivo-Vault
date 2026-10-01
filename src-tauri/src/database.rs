use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use argon2::password_hash::phc::PasswordHash;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

const PHASE_ONE_MIGRATION: &str = include_str!("../migrations/0001_phase_one.sql");
const PHASE_TWO_MIGRATION: &str =
    include_str!("../migrations/0002_drop_unused_preference_columns.sql");
const PHASE_TWO_SCHEMA_MIGRATION: &str = include_str!("../migrations/0003_phase_two.sql");
const PHASE_THREE_MIGRATION: &str = include_str!("../migrations/0004_phase_three.sql");
const NOTES_VIEW_MIGRATION: &str = include_str!("../migrations/0005_notes_view.sql");
const SOURCES_VIEW_MIGRATION: &str = include_str!("../migrations/0006_sources_view.sql");
const COLLECTIONS_VIEW_MIGRATION: &str = include_str!("../migrations/0007_collections_view.sql");
const COLLECTION_PROTECTION_MIGRATION: &str =
    include_str!("../migrations/0008_collection_protection.sql");
const INLINE_TAGS: &str = include_str!("../migrations/0009_inline_tags.sql");
const PASSWORD_VAULT_MIGRATION: &str = include_str!("../migrations/0010_password_vault.sql");
const PHASE_FIVE_MIGRATION: &str = include_str!("../migrations/0011_phase_five.sql");
const PHASE_SIX_MIGRATION: &str = include_str!("../migrations/0012_phase_six_protection.sql");
const PHASE_SEVEN_MIGRATION: &str = include_str!("../migrations/0013_phase_seven.sql");
const ACTIVITY_HISTORY_REMOVAL: &str = include_str!("../migrations/0014_drop_activity.sql");
const NAVIGATION_STYLE_MIGRATION: &str = include_str!("../migrations/0015_navigation_style.sql");
const CREDENTIAL_BLOB_MIGRATION: &str = include_str!("../migrations/0016_credential_blob.sql");
const SEALED_NAMES_MIGRATION: &str = include_str!("../migrations/0017_sealed_names.sql");
const CREDENTIAL_HISTORY_MIGRATION: &str =
    include_str!("../migrations/0018_credential_history_and_clipboard.sql");
const CAPTURE_FINGERPRINTS_MIGRATION: &str =
    include_str!("../migrations/0019_capture_fingerprints.sql");
const VAULT_KEY_SLOTS_MIGRATION: &str = include_str!("../migrations/0020_vault_key_slots.sql");

struct Migration {
    version: i64,
    sql: &'static str,
}

// Ordered by version. Each entry is applied only while the database's
// `user_version` is lower than the entry's version.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: PHASE_ONE_MIGRATION,
    },
    Migration {
        version: 2,
        sql: PHASE_TWO_MIGRATION,
    },
    Migration {
        version: 3,
        sql: PHASE_TWO_SCHEMA_MIGRATION,
    },
    Migration {
        version: 4,
        sql: PHASE_THREE_MIGRATION,
    },
    Migration {
        version: 5,
        sql: NOTES_VIEW_MIGRATION,
    },
    Migration {
        version: 6,
        sql: SOURCES_VIEW_MIGRATION,
    },
    Migration {
        version: 7,
        sql: COLLECTIONS_VIEW_MIGRATION,
    },
    Migration {
        version: 8,
        sql: COLLECTION_PROTECTION_MIGRATION,
    },
    Migration {
        version: 9,
        sql: INLINE_TAGS,
    },
    Migration {
        version: 10,
        sql: PASSWORD_VAULT_MIGRATION,
    },
    Migration {
        version: 11,
        sql: PHASE_FIVE_MIGRATION,
    },
    Migration {
        version: 12,
        sql: PHASE_SIX_MIGRATION,
    },
    Migration {
        version: 13,
        sql: PHASE_SEVEN_MIGRATION,
    },
    Migration {
        version: 14,
        sql: ACTIVITY_HISTORY_REMOVAL,
    },
    Migration {
        version: 15,
        sql: NAVIGATION_STYLE_MIGRATION,
    },
    Migration {
        version: 16,
        sql: CREDENTIAL_BLOB_MIGRATION,
    },
    Migration {
        version: 17,
        sql: SEALED_NAMES_MIGRATION,
    },
    Migration {
        version: 18,
        sql: CREDENTIAL_HISTORY_MIGRATION,
    },
    Migration {
        version: 19,
        sql: CAPTURE_FINGERPRINTS_MIGRATION,
    },
    Migration {
        version: 20,
        sql: VAULT_KEY_SLOTS_MIGRATION,
    },
];

pub struct DatabaseState {
    connection: Mutex<Option<Connection>>,
    path: PathBuf,
    files_dir: PathBuf,
    // The in-memory content key lives with the connection so one managed state
    // owns both and the commands cannot disagree about which vault is open.
    content_key: crate::encryption::ContentKeyState,
    // Protected collections opened with their PIN or password this session.
    // Cleared whenever the app locks, so a lock closes them all again.
    unlocked_collections: Mutex<HashSet<String>>,
    // Wrong tries across every password and PIN check. Memory only; a restart
    // clears it, which still turns a quick guessing run into a slow one.
    attempts: Mutex<Attempts>,
    // Goes up on every collection lock or unlock. Results that name items or
    // collections carry it so the UI can drop answers from an older access state.
    access_epoch: AtomicU64,
    // Goes up on lock, restore, reset, and encryption changes. Work started
    // under an older value (such as a staged import) is refused.
    session_generation: AtomicU64,
    // The one file staged by `preview_file_import`, waiting for a decision.
    pending_import: Mutex<Option<PendingImport>>,
    // A recovery kit shown to the user but not yet confirmed. Holds only the
    // proposed wrapper and the secret for re-entry checks; never the data key.
    pending_recovery: Mutex<Option<PendingRecovery>>,
}

/// A recovery kit that was created and shown but not yet confirmed. It is
/// only usable while nothing it was built against has changed: same vault
/// identity, same password slot, same previous recovery slot.
pub(crate) struct PendingRecovery {
    pub token: String,
    pub scope: String,
    pub created: std::time::Instant,
    pub kit: zeroize::Zeroizing<String>,
    pub vault_id: String,
    pub key_generation: String,
    pub password_slot_id: String,
    pub previous_recovery_id: Option<String>,
    pub recovery_id: String,
    pub envelope_json: String,
}

/// A file copied into app-private staging so the bytes Kivo checked are the
/// bytes it saves. While encryption is on the staged copy is sealed with the
/// content key, so no plaintext copy is written to disk.
pub(crate) struct PendingImport {
    pub token: String,
    pub generation: u64,
    pub created: std::time::Instant,
    pub staged: PathBuf,
    pub encrypted: bool,
    pub original_name: String,
    pub byte_size: i64,
    pub digest: [u8; 32],
}

impl Drop for PendingImport {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
    }
}

#[derive(Default)]
struct Attempts {
    failures: u32,
    blocked_until: Option<std::time::Instant>,
}

/// Free tries before the first wait.
const FREE_ATTEMPTS: u32 = 5;
const FIRST_WAIT_SECONDS: u64 = 30;
const MAX_WAIT_SECONDS: u64 = 300;

/// Wait after `failures` wrong tries: none for the first five, then 30 s,
/// doubling up to five minutes.
fn attempt_wait(failures: u32) -> u64 {
    if failures < FREE_ATTEMPTS {
        return 0;
    }
    let doublings = (failures - FREE_ATTEMPTS).min(16);
    (FIRST_WAIT_SECONDS << doublings).min(MAX_WAIT_SECONDS)
}

#[allow(dead_code)]
pub(crate) const COLLECTION_LOCKED: &str = "This collection is locked";

/// Protected collections that have not been opened with their secret since the
/// app last locked. Their items stay out of every list and command.
#[allow(dead_code)]
pub(crate) fn locked_collection_ids(
    connection: &Connection,
    state: &DatabaseState,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT id FROM collections WHERE protection <> 'none'")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;

    Ok(ids
        .into_iter()
        .filter(|id| !state.is_collection_unlocked(id))
        .collect())
}

/// SQL that keeps out items of the given locked collections. The caller binds
/// the ids as parameters, in order, where this text sits in the query.
#[allow(dead_code)]
pub(crate) fn locked_filter_sql(column: &str, locked: &[String]) -> String {
    if locked.is_empty() {
        return String::new();
    }

    format!(
        " AND ({column} IS NULL OR {column} NOT IN ({}))",
        vec!["?"; locked.len()].join(",")
    )
}

#[allow(dead_code)]
pub(crate) fn ensure_collection_accessible(
    connection: &Connection,
    state: &DatabaseState,
    collection_id: &str,
) -> Result<(), String> {
    let protection: Option<String> = connection
        .query_row(
            "SELECT protection FROM collections WHERE id = ?1",
            params![collection_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    match protection {
        Some(protection)
            if protection != "none" && !state.is_collection_unlocked(collection_id) =>
        {
            Err(COLLECTION_LOCKED.to_string())
        }
        _ => Ok(()),
    }
}

/// Refuses an item that sits in a locked collection. A missing item passes so
/// the command reports its own "not found".
#[allow(dead_code)]
pub(crate) fn ensure_item_accessible(
    connection: &Connection,
    state: &DatabaseState,
    item_id: &str,
) -> Result<(), String> {
    let collection_id: Option<Option<String>> = connection
        .query_row(
            "SELECT collection_id FROM items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    match collection_id.flatten() {
        Some(collection_id) => ensure_collection_accessible(connection, state, &collection_id),
        None => Ok(()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInput {
    pub owner_name: String,
    pub vault_name: String,
    pub starter_collections: Vec<String>,
    pub password_verifier: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub owner_name: String,
    pub vault_name: String,
    pub setup_completed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub owner_name: String,
    pub vault_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub density: String,
    pub start_at_login: bool,
    pub notes_view: String,
    pub sources_view: String,
    pub collections_view: String,
    pub navigation_style: String,
    #[serde(default)]
    pub auto_lock_minutes: i64,
    #[serde(default)]
    pub semantic_search: bool,
    #[serde(default)]
    pub auto_tag: bool,
    #[serde(default)]
    pub summaries: bool,
    #[serde(default)]
    pub clipboard_clear_seconds: i64,
    #[serde(default)]
    pub clipboard_exclude_history: bool,
    #[serde(default = "default_link_details")]
    pub link_details: bool,
}

fn default_link_details() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BootState {
    Onboarding,
    Ready,
    Locked,
}

impl DatabaseState {
    pub fn new(path: PathBuf, files_dir: PathBuf) -> Self {
        Self {
            connection: Mutex::new(None),
            path,
            files_dir,
            content_key: crate::encryption::ContentKeyState::default(),
            unlocked_collections: Mutex::new(HashSet::new()),
            attempts: Mutex::new(Attempts::default()),
            access_epoch: AtomicU64::new(0),
            session_generation: AtomicU64::new(0),
            pending_import: Mutex::new(None),
            pending_recovery: Mutex::new(None),
        }
    }

    pub(crate) fn access_epoch(&self) -> u64 {
        self.access_epoch.load(Ordering::SeqCst)
    }

    fn advance_access_epoch(&self) {
        self.access_epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn session_generation(&self) -> u64 {
        self.session_generation.load(Ordering::SeqCst)
    }

    /// Ends the current session's pending work: the generation moves on and
    /// any staged import is dropped (its file is deleted). Never resets.
    pub(crate) fn advance_session(&self) {
        self.session_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending_import.lock() {
            pending.take();
        }
        self.clear_pending_recovery();
    }

    pub(crate) fn pending_recovery(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<PendingRecovery>>, String> {
        self.pending_recovery
            .lock()
            .map_err(|_| "Could not read the recovery kit setup".to_string())
    }

    /// Drops an unconfirmed recovery kit (on lock, restore, reset, password change).
    pub(crate) fn clear_pending_recovery(&self) {
        if let Ok(mut pending) = self.pending_recovery.lock() {
            pending.take();
        }
    }

    pub(crate) fn pending_import(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<PendingImport>>, String> {
        self.pending_import
            .lock()
            .map_err(|_| "Could not read the staged file".to_string())
    }

    /// App-private folder for staged imports, next to the database.
    pub(crate) fn staging_dir(&self) -> PathBuf {
        self.path
            .parent()
            .map(|parent| parent.join("pending-import"))
            .unwrap_or_else(|| PathBuf::from("pending-import"))
    }

    /// Windows Hello setups for this installation: outside the database and
    /// the managed files, so backups and exports never include them.
    pub(crate) fn device_dir(&self) -> PathBuf {
        self.path
            .parent()
            .map(|parent| parent.join("device-unlock"))
            .unwrap_or_else(|| PathBuf::from("device-unlock"))
    }

    /// Removes the Windows Hello setup for one vault (`content` or
    /// `passwords`). Called on password change, recovery, encryption changes,
    /// restore and reset; the user sets it up again afterwards.
    pub(crate) fn revoke_device_unlock(&self, scope: &str) {
        let _ = fs::remove_file(self.device_dir().join(format!("{scope}.json")));
    }

    /// Refuses a password or PIN check while a wait from earlier wrong tries
    /// is still running.
    pub(crate) fn check_attempt(&self) -> Result<(), String> {
        let attempts = self
            .attempts
            .lock()
            .map_err(|_| "Could not check the password".to_string())?;
        if let Some(until) = attempts.blocked_until {
            let now = std::time::Instant::now();
            if until > now {
                let seconds = (until - now).as_secs() + 1;
                return Err(format!("Too many wrong tries. Wait {seconds} seconds."));
            }
        }
        Ok(())
    }

    pub(crate) fn record_attempt(&self, ok: bool) {
        let Ok(mut attempts) = self.attempts.lock() else {
            return;
        };
        if ok {
            *attempts = Attempts::default();
            return;
        }
        attempts.failures += 1;
        let wait = attempt_wait(attempts.failures);
        if wait > 0 {
            attempts.blocked_until =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(wait));
        }
    }

    pub fn initialize(&self) -> Result<(), String> {
        let mut stored_connection = self.lock_connection()?;

        if stored_connection.is_some() {
            return Ok(());
        }

        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create local database directory: {error}"))?;
        }

        fs::create_dir_all(&self.files_dir)
            .map_err(|error| format!("Could not create managed files directory: {error}"))?;

        let mut connection = Connection::open(&self.path)
            .map_err(|error| format!("Could not open local database: {error}"))?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| format!("Could not enable foreign keys: {error}"))?;
        // Deleted or overwritten rows are zeroed on disk, so removed plaintext
        // does not linger in free pages.
        connection
            .pragma_update(None, "secure_delete", "ON")
            .map_err(|error| format!("Could not enable secure delete: {error}"))?;
        apply_migrations(&mut connection)
            .map_err(|error| format!("Could not migrate local database: {error}"))?;
        crate::encryption::recover_files(&connection, &self.files_dir)?;

        *stored_connection = Some(connection);
        Ok(())
    }

    fn lock_connection(&self) -> Result<std::sync::MutexGuard<'_, Option<Connection>>, String> {
        self.connection
            .lock()
            .map_err(|_| "Local database lock is poisoned".to_string())
    }

    pub(crate) fn require_connection(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<Connection>>, String> {
        let connection = self.lock_connection()?;
        if connection.is_none() {
            return Err("Local database is not initialized".to_string());
        }
        Ok(connection)
    }

    pub(crate) fn files_dir(&self) -> &Path {
        &self.files_dir
    }

    pub(crate) fn database_path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn content_key(&self) -> &crate::encryption::ContentKeyState {
        &self.content_key
    }

    #[allow(dead_code)]
    pub(crate) fn unlock_collection(&self, id: &str) {
        if let Ok(mut unlocked) = self.unlocked_collections.lock() {
            unlocked.insert(id.to_string());
        }
        self.advance_access_epoch();
    }

    #[allow(dead_code)]
    pub(crate) fn is_collection_unlocked(&self, id: &str) -> bool {
        self.unlocked_collections
            .lock()
            .map(|unlocked| unlocked.contains(id))
            .unwrap_or(false)
    }

    #[allow(dead_code)]
    pub(crate) fn lock_collection(&self, id: &str) {
        if let Ok(mut unlocked) = self.unlocked_collections.lock() {
            unlocked.remove(id);
        }
        self.advance_access_epoch();
    }

    pub(crate) fn clear_unlocked_collections(&self) {
        if let Ok(mut unlocked) = self.unlocked_collections.lock() {
            unlocked.clear();
        }
        self.advance_access_epoch();
    }

    // Drops the live connection so restore can replace the database file. The
    // connection is reopened through `initialize`, which also migrates and
    // recovers any interrupted file conversion.
    pub(crate) fn close_connection(&self) -> Result<(), String> {
        self.clear_unlocked_collections();
        self.advance_session();
        let mut stored = self.lock_connection()?;
        drop(stored.take());
        Ok(())
    }

    pub(crate) fn reopen_connection(&self) -> Result<(), String> {
        self.initialize()
    }

    // Deletes the database and every managed file, then opens a fresh, empty
    // database, so the app starts over at onboarding. The connection is reopened
    // even when a delete fails so the app is never left without a database.
    pub(crate) fn reset(&self) -> Result<(), String> {
        let _ = self.content_key.clear();
        self.close_connection()?;
        let _ = fs::remove_dir_all(self.device_dir());

        let mut removed = Ok(());
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut name = self.path.as_os_str().to_owned();
            name.push(suffix);
            let path = PathBuf::from(name);
            if path.exists() {
                if let Err(error) = fs::remove_file(&path) {
                    removed = Err(format!("Could not delete the local database: {error}"));
                }
            }
        }
        for dir in [
            self.files_dir.clone(),
            self.files_dir.with_extension("content-conversion"),
        ] {
            if dir.exists() {
                if let Err(error) = fs::remove_dir_all(&dir) {
                    removed = Err(format!("Could not delete managed files: {error}"));
                }
            }
        }

        let reopened = self.initialize();
        removed.and(reopened)
    }

    fn boot_state(&self) -> Result<BootState, String> {
        let connection = self.require_connection()?;
        read_boot_state(connection.as_ref().expect("checked above"))
            .map_err(|error| format!("Could not read local startup state: {error}"))
    }

    fn complete_setup(&self, input: SetupInput) -> Result<(), String> {
        validate_setup(&input)?;

        let mut connection = self.require_connection()?;
        write_setup(connection.as_mut().expect("checked above"), &input)
            .map_err(|error| format!("Could not complete setup: {error}"))
    }

    fn read_profile(&self) -> Result<Profile, String> {
        let connection = self.require_connection()?;
        read_profile(connection.as_ref().expect("checked above"))
            .map_err(|error| format!("Could not read the profile: {error}"))
    }

    fn save_profile(&self, profile: &ProfileInput) -> Result<(), String> {
        if profile.owner_name.trim().is_empty() {
            return Err("Owner name is required".to_string());
        }

        let mut connection = self.require_connection()?;
        write_profile(connection.as_mut().expect("checked above"), profile)
            .map_err(|error| format!("Could not save the profile: {error}"))
    }

    fn read_preferences(&self) -> Result<Preferences, String> {
        let connection = self.require_connection()?;
        read_preferences(connection.as_ref().expect("checked above"))
            .map_err(|error| format!("Could not read preferences: {error}"))
    }

    fn save_preferences(&self, preferences: &Preferences) -> Result<(), String> {
        validate_preferences(preferences)?;

        let mut connection = self.require_connection()?;
        write_preferences(connection.as_mut().expect("checked above"), preferences)
            .map_err(|error| format!("Could not save preferences: {error}"))
    }

    fn set_password_verifier(&self, verifier: &str) -> Result<(), String> {
        let verifier = validate_verifier(verifier)?;

        let mut connection = self.require_connection()?;
        if crate::encryption::is_enabled(connection.as_ref().expect("checked above"))? {
            return Err("Use change_master_password while encryption is enabled".into());
        }
        write_password_verifier(connection.as_mut().expect("checked above"), verifier)
            .map_err(|error| format!("Could not save app lock: {error}"))?;
        self.revoke_device_unlock("content");
        Ok(())
    }

    fn remove_password_verifier(&self) -> Result<(), String> {
        let mut connection = self.require_connection()?;
        if crate::encryption::is_enabled(connection.as_ref().expect("checked above"))? {
            return Err("Disable encryption before removing app lock".into());
        }
        clear_password_verifier(connection.as_mut().expect("checked above"))
            .map_err(|error| format!("Could not remove app lock: {error}"))?;
        self.revoke_device_unlock("content");
        Ok(())
    }

    fn password_verifier(&self) -> Result<Option<String>, String> {
        let connection = self.require_connection()?;
        read_password_verifier(connection.as_ref().expect("checked above"))
            .map_err(|error| format!("Could not read app lock: {error}"))
    }

    fn has_password_verifier(&self) -> Result<bool, String> {
        let connection = self.require_connection()?;
        has_stored_password_lock(connection.as_ref().expect("checked above"))
            .map_err(|error| format!("Could not read app lock: {error}"))
    }
}

fn validate_setup(input: &SetupInput) -> Result<(), String> {
    if input.owner_name.trim().is_empty() {
        return Err("Owner name is required".to_string());
    }

    let mut seen = std::collections::HashSet::new();

    for name in &input.starter_collections {
        let trimmed = name.trim();

        if trimmed.is_empty() {
            return Err("Collection names cannot be empty".to_string());
        }

        // Mirrors SQLite's default case-sensitive UNIQUE comparison for this column.
        if !seen.insert(trimmed) {
            return Err("Collection names must not repeat".to_string());
        }
    }

    Ok(())
}

fn validate_preferences(preferences: &Preferences) -> Result<(), String> {
    let valid = matches!(preferences.theme.as_str(), "light" | "dark" | "system")
        && matches!(preferences.density.as_str(), "comfortable" | "compact")
        && matches!(preferences.notes_view.as_str(), "grid" | "list")
        && matches!(preferences.sources_view.as_str(), "grid" | "list")
        && matches!(preferences.collections_view.as_str(), "grid" | "list")
        && matches!(preferences.navigation_style.as_str(), "dock" | "sidebar");
    let valid = valid
        && preferences.auto_lock_minutes >= 0
        && matches!(preferences.clipboard_clear_seconds, 0 | 30 | 60 | 120);

    if valid {
        Ok(())
    } else {
        Err("Preferences contain an unsupported value".to_string())
    }
}

fn validate_verifier(verifier: &str) -> Result<&str, String> {
    let trimmed = verifier.trim();

    if trimmed.is_empty() {
        return Err("Password verifier is required".to_string());
    }

    if !trimmed.starts_with("$argon2id$") {
        return Err("Password verifier is not supported".to_string());
    }

    PasswordHash::new(trimmed).map_err(|_| "Password verifier is not valid".to_string())?;

    Ok(trimmed)
}

pub fn apply_migrations(connection: &mut Connection) -> rusqlite::Result<()> {
    let current_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    for migration in MIGRATIONS {
        if migration.version <= current_version {
            continue;
        }

        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql)?;
        // Rust is authoritative for the bookkeeping so the gate cannot drift from the SQL.
        transaction.pragma_update(None, "user_version", migration.version)?;
        transaction.commit()?;
    }

    Ok(())
}

pub fn read_boot_state(connection: &Connection) -> rusqlite::Result<BootState> {
    let setup_completed_at: Option<String> = connection
        .query_row(
            "SELECT setup_completed_at FROM profile WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    if setup_completed_at.is_none() {
        return Ok(BootState::Onboarding);
    }

    if has_stored_password_lock(connection)? {
        Ok(BootState::Locked)
    } else {
        Ok(BootState::Ready)
    }
}

/// A lock exists only when the stored value is a parseable Argon2 PHC verifier.
/// A corrupted or foreign value can never verify, so it is never trusted as a
/// lock. Boot classification and the settings UI both read this one answer so
/// they cannot disagree.
pub fn has_stored_password_lock(connection: &Connection) -> rusqlite::Result<bool> {
    match read_password_verifier(connection)? {
        Some(verifier) => Ok(validate_verifier(&verifier).is_ok()),
        None => Ok(false),
    }
}

fn resolve_vault_name(owner_name: &str, vault_name: &str) -> String {
    let vault_name = vault_name.trim();

    if vault_name.is_empty() {
        format!("{}'s Vault", owner_name.trim())
    } else {
        vault_name.to_string()
    }
}

pub fn write_setup(connection: &mut Connection, input: &SetupInput) -> rusqlite::Result<()> {
    let owner_name = input.owner_name.trim();
    let vault_name = resolve_vault_name(owner_name, &input.vault_name);

    let transaction = connection.transaction()?;

    transaction.execute(
        "INSERT INTO profile (id, owner_name, vault_name, setup_completed_at)
         VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![owner_name, vault_name],
    )?;

    transaction.execute(
        "INSERT INTO preferences (id, theme, density, start_at_login)
         VALUES (1, 'dark', 'comfortable', 0)",
        [],
    )?;

    for (sort_order, collection_name) in input.starter_collections.iter().enumerate() {
        let sort_order =
            i64::try_from(sort_order).expect("collection count fits in SQLite integer");
        transaction.execute(
            "INSERT INTO collections (id, name, sort_order, created_at)
             VALUES (lower(hex(randomblob(16))), ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![collection_name.trim(), sort_order],
        )?;
    }

    transaction.execute(
        "INSERT INTO security (id, password_verifier, updated_at)
         VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![input.password_verifier.as_deref()],
    )?;

    transaction.commit()
}

pub fn read_profile(connection: &Connection) -> rusqlite::Result<Profile> {
    connection.query_row(
        "SELECT owner_name, vault_name, setup_completed_at FROM profile WHERE id = 1",
        [],
        |row| {
            Ok(Profile {
                owner_name: row.get(0)?,
                vault_name: row.get(1)?,
                setup_completed_at: row.get(2)?,
            })
        },
    )
}

pub fn write_profile(connection: &mut Connection, profile: &ProfileInput) -> rusqlite::Result<()> {
    let owner_name = profile.owner_name.trim();
    let vault_name = resolve_vault_name(owner_name, &profile.vault_name);

    let transaction = connection.transaction()?;
    let updated = transaction.execute(
        "UPDATE profile SET owner_name = ?1, vault_name = ?2 WHERE id = 1",
        params![owner_name, vault_name],
    )?;

    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    transaction.commit()
}

pub fn read_preferences(connection: &Connection) -> rusqlite::Result<Preferences> {
    connection.query_row(
        "SELECT theme, density, start_at_login, notes_view, sources_view, collections_view, auto_lock_minutes, semantic_search, auto_tag, summaries, navigation_style, clipboard_clear_seconds, clipboard_exclude_history, link_details FROM preferences WHERE id = 1",
        [],
        |row| {
            Ok(Preferences {
                theme: row.get(0)?,
                density: row.get(1)?,
                start_at_login: row.get::<_, i64>(2)? != 0,
                notes_view: row.get(3)?,
                sources_view: row.get(4)?,
                collections_view: row.get(5)?,
                navigation_style: row.get(10)?,
                auto_lock_minutes: row.get(6)?,
                semantic_search: row.get::<_, i64>(7)? != 0,
                auto_tag: row.get::<_, i64>(8)? != 0,
                summaries: row.get::<_, i64>(9)? != 0,
                clipboard_clear_seconds: row.get(11)?,
                clipboard_exclude_history: row.get::<_, i64>(12)? != 0,
                link_details: row.get::<_, i64>(13)? != 0,
            })
        },
    )
}

pub fn write_preferences(
    connection: &mut Connection,
    preferences: &Preferences,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    // Read the stored switch first so turning Related search off can clear its
    // derived vectors in the same transaction.
    let previous_semantic_search: Option<i64> = transaction
        .query_row(
            "SELECT semantic_search FROM preferences WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let updated = transaction.execute(
        "UPDATE preferences
         SET theme = ?1, density = ?2, start_at_login = ?3, notes_view = ?4, sources_view = ?5,
              collections_view = ?6, auto_lock_minutes = ?7, semantic_search = ?8, auto_tag = ?9,
              summaries = ?10, navigation_style = ?11, clipboard_clear_seconds = ?12,
              clipboard_exclude_history = ?13, link_details = ?14
         WHERE id = 1",
        params![
            preferences.theme,
            preferences.density,
            i64::from(preferences.start_at_login),
            preferences.notes_view,
            preferences.sources_view,
            preferences.collections_view,
            preferences.auto_lock_minutes,
            i64::from(preferences.semantic_search),
            i64::from(preferences.auto_tag),
            i64::from(preferences.summaries),
            preferences.navigation_style,
            preferences.clipboard_clear_seconds,
            i64::from(preferences.clipboard_exclude_history),
            i64::from(preferences.link_details),
        ],
    )?;

    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }

    if previous_semantic_search == Some(1) && !preferences.semantic_search {
        transaction.execute("DELETE FROM item_vectors", [])?;
    }

    transaction.commit()
}

pub fn write_password_verifier(
    connection: &mut Connection,
    verifier: &str,
) -> rusqlite::Result<()> {
    if crate::encryption::is_enabled(connection).map_err(|_| rusqlite::Error::InvalidQuery)? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO security (id, password_verifier, updated_at)
         VALUES (1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
           password_verifier = excluded.password_verifier,
           updated_at = excluded.updated_at",
        params![verifier],
    )?;
    retire_app_lock_kit(&transaction)?;

    transaction.commit()
}

/// While encryption is off, the content vault's key slots only back an
/// app-lock recovery kit. A new or removed app-lock password retires it.
fn retire_app_lock_kit(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute("DELETE FROM vault_key_slots WHERE scope = 'content'", [])?;
    connection.execute("DELETE FROM vault_keys WHERE scope = 'content'", [])?;
    Ok(())
}

pub fn clear_password_verifier(connection: &mut Connection) -> rusqlite::Result<()> {
    if crate::encryption::is_enabled(connection).map_err(|_| rusqlite::Error::InvalidQuery)? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let transaction = connection.transaction()?;
    transaction.execute(
        "UPDATE security
         SET password_verifier = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1",
        [],
    )?;
    retire_app_lock_kit(&transaction)?;

    transaction.commit()
}

pub fn read_password_verifier(connection: &Connection) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT password_verifier FROM security WHERE id = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
}

#[tauri::command]
pub fn initialize_database(state: State<'_, DatabaseState>) -> Result<(), String> {
    state.initialize()
}

#[tauri::command]
pub fn load_boot_state(state: State<'_, DatabaseState>) -> Result<BootState, String> {
    state.boot_state()
}

#[tauri::command]
pub fn complete_setup(input: SetupInput, state: State<'_, DatabaseState>) -> Result<(), String> {
    state.complete_setup(input)
}

#[tauri::command]
pub fn load_profile(state: State<'_, DatabaseState>) -> Result<Profile, String> {
    state.read_profile()
}

#[tauri::command]
pub fn save_profile(profile: ProfileInput, state: State<'_, DatabaseState>) -> Result<(), String> {
    state.save_profile(&profile)
}

#[tauri::command]
pub fn load_preferences(state: State<'_, DatabaseState>) -> Result<Preferences, String> {
    state.read_preferences()
}

#[tauri::command]
pub fn save_preferences(
    preferences: Preferences,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    state.save_preferences(&preferences)
}

#[tauri::command]
pub fn set_password_verifier(
    verifier: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    state.set_password_verifier(&verifier)
}

#[tauri::command]
pub fn remove_password_verifier(state: State<'_, DatabaseState>) -> Result<(), String> {
    state.remove_password_verifier()
}

#[tauri::command]
pub fn load_password_verifier(state: State<'_, DatabaseState>) -> Result<Option<String>, String> {
    state.password_verifier()
}

// The settings UI asks this instead of treating any stored value as a lock, so a
// corrupted or foreign verifier cannot show controls that can never succeed.
#[tauri::command]
pub fn has_password_verifier(state: State<'_, DatabaseState>) -> Result<bool, String> {
    state.has_password_verifier()
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const VERIFIER: &str =
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn wrong_tries_wait_longer_each_time_and_success_resets() {
        assert_eq!(
            (1..=9).map(attempt_wait).collect::<Vec<_>>(),
            vec![0, 0, 0, 0, 30, 60, 120, 240, 300]
        );
        assert_eq!(attempt_wait(40), 300);

        let state = DatabaseState::new(PathBuf::from("unused.db"), PathBuf::from("unused"));
        for _ in 0..4 {
            state.record_attempt(false);
            assert!(state.check_attempt().is_ok());
        }
        state.record_attempt(false);
        let error = state.check_attempt().expect_err("fifth miss waits");
        assert!(error.starts_with("Too many wrong tries. Wait "), "{error}");

        state.record_attempt(true);
        assert!(state.check_attempt().is_ok());
    }

    struct TempWorkspace {
        root: PathBuf,
    }

    impl TempWorkspace {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after the Unix epoch")
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("kivo-test-{label}-{}-{unique}", std::process::id()));

            fs::create_dir_all(&root).expect("create temp workspace");

            Self { root }
        }

        fn database_path(&self) -> PathBuf {
            self.root.join("kivo.db")
        }

        fn files_dir(&self) -> PathBuf {
            self.root.join("files")
        }

        fn state(&self) -> DatabaseState {
            DatabaseState::new(self.database_path(), self.files_dir())
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn migrated_memory_database() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        apply_migrations(&mut connection).expect("apply migration");
        connection
    }

    fn setup_input(collections: &[&str], verifier: Option<&str>) -> SetupInput {
        SetupInput {
            owner_name: "  Ada  ".to_string(),
            vault_name: "   ".to_string(),
            starter_collections: collections.iter().map(|name| name.to_string()).collect(),
            password_verifier: verifier.map(|value| value.to_string()),
        }
    }

    fn table_exists(connection: &Connection, table: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .expect("count table")
            == 1
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                params![table, column],
                |row| row.get::<_, i64>(0),
            )
            .expect("count column")
            == 1
    }

    fn read_user_version(connection: &Connection) -> i64 {
        connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version")
    }

    fn row_count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count rows")
    }

    #[test]
    fn bundled_sqlite_supports_fts5() {
        let connection = Connection::open_in_memory().expect("open memory database");
        connection.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(body); INSERT INTO probe(body) VALUES ('local search');").expect("FTS5 available");
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM probe WHERE probe MATCH 'local'",
                [],
                |row| row.get(0),
            )
            .expect("query FTS5");
        assert_eq!(count, 1);
    }

    #[test]
    fn phase_five_upgrades_password_vault_without_losing_credentials() {
        let mut connection = Connection::open_in_memory().expect("open database");
        for migration in MIGRATIONS
            .iter()
            .filter(|migration| migration.version <= 10)
        {
            connection
                .execute_batch(migration.sql)
                .expect("apply existing migration");
        }
        connection
            .pragma_update(None, "user_version", 10)
            .expect("mark password vault version");
        connection.execute("INSERT INTO credentials(id, service, password_nonce, password_ciphertext, created_at, updated_at) VALUES ('credential-1', 'Kept', x'010203', x'040506', '2026-01-01', '2026-01-01')", []).expect("seed credential");
        apply_migrations(&mut connection).expect("upgrade version 10 vault");
        assert_eq!(read_user_version(&connection), 20);
        assert!(table_exists(&connection, "credentials"));
        assert!(table_exists(&connection, "item_search"));
        assert!(table_exists(&connection, "item_versions"));
        assert!(column_exists(&connection, "index_state", "status"));
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = connection.query_row("SELECT password_nonce, password_ciphertext FROM credentials WHERE id = 'credential-1'", [], |row| Ok((row.get(0)?, row.get(1)?))).expect("credential survives upgrade");
        assert_eq!(nonce, [1, 2, 3]);
        assert_eq!(ciphertext, [4, 5, 6]);
    }

    #[test]
    fn migration_applies_and_is_idempotent() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        apply_migrations(&mut connection).expect("first migration");
        apply_migrations(&mut connection).expect("second migration");

        assert_eq!(read_user_version(&connection), 20);

        for table in [
            "profile",
            "preferences",
            "collections",
            "security",
            "items",
            "files",
            "index_state",
            "vault_config",
            "credentials",
            "vault_keys",
            "vault_key_slots",
        ] {
            assert!(table_exists(&connection, table), "missing table {table}");
        }

        assert!(
            !table_exists(&connection, "tags"),
            "tags live on the item row now"
        );
        assert!(
            !table_exists(&connection, "activity"),
            "activity history was removed"
        );
        assert!(
            !table_exists(&connection, "item_tags"),
            "tag links live on the item row now"
        );
        assert!(
            column_exists(&connection, "items", "tags"),
            "items carries an inline tags column"
        );

        assert!(
            !table_exists(&connection, "starter_collections"),
            "the onboarding table is replaced by collections"
        );
    }

    #[test]
    fn migration_gate_skips_a_database_already_at_the_current_version() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        apply_migrations(&mut connection).expect("first migration");
        assert_eq!(read_user_version(&connection), 20);

        // Dropping a table gives the test a way to detect whether the migration ran again.
        connection
            .execute_batch("DROP TABLE preferences;")
            .expect("drop table to detect re-application");

        apply_migrations(&mut connection).expect("gate skips the applied migration");

        assert!(
            !table_exists(&connection, "preferences"),
            "an up-to-date database must not re-run its migration"
        );
        assert_eq!(read_user_version(&connection), 20);
    }

    #[test]
    fn migration_two_drops_removed_preference_columns_and_keeps_values() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a phase-one database the way it shipped, with its removed columns
        // and a stored palette, then let the gate upgrade it.
        connection
            .execute_batch(PHASE_ONE_MIGRATION)
            .expect("apply phase one");
        connection
            .execute(
                "INSERT INTO preferences
                   (id, theme, density, sidebar_mode, content_width, start_at_login)
                 VALUES (1, 'light', 'compact', 'collapsed', 'wide', 1)",
                [],
            )
            .expect("seed phase one preferences");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);
        assert_eq!(
            read_preferences(&connection).expect("read preferences"),
            Preferences {
                theme: "light".to_string(),
                density: "compact".to_string(),
                start_at_login: true,
                notes_view: "grid".to_string(),
                sources_view: "grid".to_string(),
                collections_view: "grid".to_string(),
                navigation_style: "dock".to_string(),
                auto_lock_minutes: 0,
                semantic_search: false,
                auto_tag: false,
                summaries: false,
                clipboard_clear_seconds: 0,
                clipboard_exclude_history: false,
                link_details: true,
            }
        );

        let removed_columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('preferences')
                 WHERE name IN ('sidebar_mode', 'content_width')",
                [],
                |row| row.get(0),
            )
            .expect("inspect columns");
        assert_eq!(removed_columns, 0, "removed preference columns are dropped");
    }

    #[test]
    fn migration_three_moves_starter_collections_into_collections() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a version-two database the way it shipped, with onboarding rows,
        // then let the gate upgrade it.
        connection
            .execute_batch(PHASE_ONE_MIGRATION)
            .expect("apply phase one");
        connection
            .execute_batch(PHASE_TWO_MIGRATION)
            .expect("apply phase two");
        connection
            .execute(
                "INSERT INTO profile (id, owner_name, vault_name, setup_completed_at)
                 VALUES (1, 'Ada', 'Ada''s Vault', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed profile");
        connection
            .execute(
                "INSERT INTO preferences (id, theme, density, start_at_login)
                 VALUES (1, 'light', 'compact', 1)",
                [],
            )
            .expect("seed preferences");
        connection
            .execute(
                "INSERT INTO starter_collections (name, sort_order) VALUES ('Projects', 0)",
                [],
            )
            .expect("seed first collection");
        connection
            .execute(
                "INSERT INTO starter_collections (name, sort_order) VALUES ('Recipes', 1)",
                [],
            )
            .expect("seed second collection");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("set version two");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);
        assert!(
            !table_exists(&connection, "starter_collections"),
            "the onboarding table is dropped after the copy"
        );

        let collections: Vec<(String, i64)> = {
            let mut statement = connection
                .prepare("SELECT name, sort_order FROM collections ORDER BY sort_order")
                .expect("prepare collection read");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query collections");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect collections")
        };
        assert_eq!(
            collections,
            vec![("Projects".to_string(), 0), ("Recipes".to_string(), 1)]
        );

        let profile = read_profile(&connection).expect("read profile");
        assert_eq!(profile.owner_name, "Ada");
        assert_eq!(profile.vault_name, "Ada's Vault");
        assert_eq!(
            read_preferences(&connection).expect("read preferences"),
            Preferences {
                theme: "light".to_string(),
                density: "compact".to_string(),
                start_at_login: true,
                notes_view: "grid".to_string(),
                sources_view: "grid".to_string(),
                collections_view: "grid".to_string(),
                navigation_style: "dock".to_string(),
                auto_lock_minutes: 0,
                semantic_search: false,
                auto_tag: false,
                summaries: false,
                clipboard_clear_seconds: 0,
                clipboard_exclude_history: false,
                link_details: true,
            }
        );
    }

    #[test]
    fn migration_four_adds_phase_three_columns_and_keeps_data() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a version-three vault the way it shipped, with an item and a
        // collection, then let the gate upgrade it with migration four.
        connection
            .execute_batch(PHASE_ONE_MIGRATION)
            .expect("apply phase one");
        connection
            .execute_batch(PHASE_TWO_MIGRATION)
            .expect("apply phase two");
        connection
            .execute_batch(PHASE_TWO_SCHEMA_MIGRATION)
            .expect("apply version three");
        connection
            .execute(
                "INSERT INTO collections (id, name, sort_order, created_at)
                 VALUES ('col-1', 'Projects', 0, '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed collection");
        connection
            .execute(
                "INSERT INTO items
                   (id, kind, title, description, content, url, collection_id, is_favorite,
                    created_at, updated_at)
                 VALUES ('item-1', 'note', 'Kept', '', 'body', NULL, 'col-1', 1,
                         '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
                [],
            )
            .expect("seed item");
        connection
            .pragma_update(None, "user_version", 3)
            .expect("set version three");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);

        let (title, content, is_pinned, deleted_at, icon): (
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT i.title, i.content, i.is_pinned, i.deleted_at, c.icon
                 FROM items i
                 JOIN collections c ON c.id = i.collection_id
                 WHERE i.id = 'item-1'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read upgraded item");

        assert_eq!(title, "Kept");
        assert_eq!(content, "body");
        assert_eq!(is_pinned, 0, "existing items start unpinned");
        assert_eq!(deleted_at, None, "existing items start live");
        assert_eq!(icon, None, "existing collections start without an icon");
    }

    #[test]
    fn migration_seven_defaults_existing_preferences_to_grid() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a version-six vault the way it shipped, then let the gate add the
        // Collections view preference.
        for migration in [
            PHASE_ONE_MIGRATION,
            PHASE_TWO_MIGRATION,
            PHASE_TWO_SCHEMA_MIGRATION,
            PHASE_THREE_MIGRATION,
            NOTES_VIEW_MIGRATION,
            SOURCES_VIEW_MIGRATION,
        ] {
            connection
                .execute_batch(migration)
                .expect("apply shipped migration");
        }
        connection
            .execute(
                "INSERT INTO preferences (id, theme, density, start_at_login)
                 VALUES (1, 'light', 'compact', 0)",
                [],
            )
            .expect("seed preferences");
        connection
            .pragma_update(None, "user_version", 6)
            .expect("set version six");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);
        let collections_view: String = connection
            .query_row(
                "SELECT collections_view FROM preferences WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read collections view");
        assert_eq!(collections_view, "grid");
    }

    #[test]
    fn migration_eight_defaults_existing_collections_to_no_protection() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a version-seven vault with a collection, then let the gate add the
        // protection columns. Existing rows start unprotected and unhashed.
        for migration in [
            PHASE_ONE_MIGRATION,
            PHASE_TWO_MIGRATION,
            PHASE_TWO_SCHEMA_MIGRATION,
            PHASE_THREE_MIGRATION,
            NOTES_VIEW_MIGRATION,
            SOURCES_VIEW_MIGRATION,
            COLLECTIONS_VIEW_MIGRATION,
        ] {
            connection
                .execute_batch(migration)
                .expect("apply shipped migration");
        }
        connection
            .execute(
                "INSERT INTO collections (id, name, sort_order, created_at)
                 VALUES ('col-old', 'Legacy', 0, '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed collection");
        connection
            .pragma_update(None, "user_version", 7)
            .expect("set version seven");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);
        let (protection, secret_hash): (String, Option<String>) = connection
            .query_row(
                "SELECT protection, secret_hash FROM collections WHERE id = 'col-old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read protection");
        assert_eq!(protection, "none");
        assert_eq!(secret_hash, None);
    }

    #[test]
    fn migration_nine_folds_tag_links_into_the_item_row() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");

        // Stage a version-eight vault with one tagged item, then let the gate move
        // the tag onto the item and drop the old tag tables.
        for migration in [
            PHASE_ONE_MIGRATION,
            PHASE_TWO_MIGRATION,
            PHASE_TWO_SCHEMA_MIGRATION,
            PHASE_THREE_MIGRATION,
            NOTES_VIEW_MIGRATION,
            SOURCES_VIEW_MIGRATION,
            COLLECTIONS_VIEW_MIGRATION,
            COLLECTION_PROTECTION_MIGRATION,
        ] {
            connection
                .execute_batch(migration)
                .expect("apply shipped migration");
        }
        connection
            .execute(
                "INSERT INTO items (id, kind, title, created_at, updated_at)
                 VALUES ('item-1', 'note', 'Tagged', '2026-01-01T00:00:00.000Z',
                         '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed item");
        connection
            .execute(
                "INSERT INTO tags (id, name, created_at)
                 VALUES ('tag-1', 'Rust', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed tag");
        connection
            .execute(
                "INSERT INTO item_tags (item_id, tag_id) VALUES ('item-1', 'tag-1')",
                [],
            )
            .expect("seed tag link");
        connection
            .pragma_update(None, "user_version", 8)
            .expect("set version eight");

        apply_migrations(&mut connection).expect("upgrade database");

        assert_eq!(read_user_version(&connection), 20);
        let tags: String = connection
            .query_row("SELECT tags FROM items WHERE id = 'item-1'", [], |row| {
                row.get(0)
            })
            .expect("read inline tags");
        assert_eq!(tags, "[\"Rust\"]");
        assert!(
            !table_exists(&connection, "tags"),
            "the tags table is dropped"
        );
        assert!(
            !table_exists(&connection, "item_tags"),
            "the item_tags table is dropped"
        );
    }

    #[test]
    fn fresh_database_reads_onboarding() {
        let connection = migrated_memory_database();

        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Onboarding
        );
    }

    #[test]
    fn completed_setup_without_verifier_reads_ready() {
        let mut connection = migrated_memory_database();

        write_setup(&mut connection, &setup_input(&["Projects"], None)).expect("write setup");

        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Ready
        );
    }

    #[test]
    fn completed_setup_with_verifier_reads_locked() {
        let mut connection = migrated_memory_database();

        write_setup(&mut connection, &setup_input(&["Projects"], Some(VERIFIER)))
            .expect("write setup");

        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Locked
        );
    }

    #[test]
    fn corrupted_password_verifier_does_not_lock_the_app() {
        for corrupted in [
            "not-a-phc-string",
            "$pbkdf2-sha256$i=600000,l=32$c2FsdA$aGFzaA",
            "$argon2id$not-really-a-phc",
        ] {
            let mut connection = migrated_memory_database();
            write_setup(&mut connection, &setup_input(&[], Some(corrupted))).expect("write setup");

            assert_eq!(
                read_boot_state(&connection).expect("read boot state"),
                BootState::Ready,
                "corrupted verifier {corrupted} must not trap the user"
            );

            // The lock-state answer must agree with boot classification.
            assert!(
                !has_stored_password_lock(&connection).expect("read lock state"),
                "corrupted verifier {corrupted} must not report a lock"
            );

            // The stored value is left untouched so the user can still replace or clear it.
            assert_eq!(
                read_password_verifier(&connection)
                    .expect("read verifier")
                    .as_deref(),
                Some(corrupted)
            );
        }
    }

    #[test]
    fn valid_password_verifier_reports_the_lock_present() {
        let mut connection = migrated_memory_database();
        write_setup(&mut connection, &setup_input(&[], Some(VERIFIER))).expect("write setup");

        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Locked
        );
        assert!(has_stored_password_lock(&connection).expect("read lock state"));
    }

    #[test]
    fn database_state_reports_a_corrupted_verifier_as_no_lock_and_stays_unlocked() {
        let workspace = TempWorkspace::new("corrupted-lock-state");
        let state = workspace.state();
        state.initialize().expect("initialize database");
        state
            .complete_setup(setup_input(&[], None))
            .expect("complete setup");

        // Simulate tampering by writing past set_password_verifier validation.
        {
            let connection = state.lock_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute(
                    "UPDATE security SET password_verifier = 'not-a-phc-string' WHERE id = 1",
                    [],
                )
                .expect("corrupt stored verifier");
        }

        assert!(!state
            .has_password_verifier()
            .expect("read lock-state command answer"));
        assert_eq!(
            state.boot_state().expect("read boot state"),
            BootState::Ready
        );
        assert_eq!(
            state.password_verifier().expect("read verifier").as_deref(),
            Some("not-a-phc-string")
        );
    }

    #[test]
    fn reset_deletes_the_vault_and_returns_to_onboarding() {
        let workspace = TempWorkspace::new("reset");
        let state = workspace.state();
        state.initialize().expect("initialize database");
        state
            .complete_setup(setup_input(&["Projects"], Some(VERIFIER)))
            .expect("complete setup");
        fs::write(workspace.files_dir().join("stored.bin"), b"data").expect("write managed file");
        assert_ne!(state.boot_state().expect("boot state"), BootState::Onboarding);

        state.reset().expect("reset vault");

        assert_eq!(state.boot_state().expect("boot state"), BootState::Onboarding);
        assert!(!workspace.files_dir().join("stored.bin").exists());
        assert!(workspace.files_dir().exists(), "files folder is recreated empty");
    }

    #[test]
    fn clipboard_preferences_round_trip_and_reject_unknown_delays() {
        let mut connection = Connection::open_in_memory().expect("open database");
        apply_migrations(&mut connection).expect("migrate");
        connection
            .execute(
                "INSERT INTO preferences (id, theme, density, start_at_login)
                 VALUES (1, 'light', 'compact', 0)",
                [],
            )
            .expect("seed preferences");
        let mut preferences = read_preferences(&connection).expect("read preferences");
        assert_eq!(preferences.clipboard_clear_seconds, 0);
        assert!(!preferences.clipboard_exclude_history);

        preferences.clipboard_clear_seconds = 60;
        preferences.clipboard_exclude_history = true;
        validate_preferences(&preferences).expect("60 seconds is allowed");
        write_preferences(&mut connection, &preferences).expect("write preferences");
        assert_eq!(
            read_preferences(&connection).expect("read preferences"),
            preferences
        );

        preferences.clipboard_clear_seconds = 45;
        assert!(validate_preferences(&preferences).is_err());
    }

    #[test]
    fn complete_setup_writes_every_table_and_a_completion_timestamp() {
        let workspace = TempWorkspace::new("complete-setup");
        let state = workspace.state();
        state.initialize().expect("initialize database");

        state
            .complete_setup(setup_input(&["Projects", "Recipes"], Some(VERIFIER)))
            .expect("complete setup");

        let connection = Connection::open(workspace.database_path()).expect("reopen database");

        let profile = read_profile(&connection).expect("read profile");
        assert_eq!(profile.owner_name, "Ada");
        assert_eq!(profile.vault_name, "Ada's Vault");
        assert!(
            profile.setup_completed_at.is_some(),
            "completion timestamp is set"
        );

        assert_eq!(
            read_preferences(&connection).expect("read preferences"),
            Preferences {
                theme: "dark".to_string(),
                density: "comfortable".to_string(),
                start_at_login: false,
                notes_view: "grid".to_string(),
                sources_view: "grid".to_string(),
                collections_view: "grid".to_string(),
                navigation_style: "dock".to_string(),
                auto_lock_minutes: 0,
                semantic_search: false,
                auto_tag: false,
                summaries: false,
                clipboard_clear_seconds: 0,
                clipboard_exclude_history: false,
                link_details: true,
            }
        );

        let collections: Vec<(String, i64)> = {
            let mut statement = connection
                .prepare("SELECT name, sort_order FROM collections ORDER BY sort_order")
                .expect("prepare collection read");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query collections");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect collections")
        };
        assert_eq!(
            collections,
            vec![("Projects".to_string(), 0), ("Recipes".to_string(), 1)]
        );

        let verifier: Option<String> = connection
            .query_row(
                "SELECT password_verifier FROM security WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("read security row");
        assert_eq!(verifier.as_deref(), Some(VERIFIER));
    }

    #[test]
    fn failing_complete_setup_rolls_back_and_leaves_setup_incomplete() {
        let workspace = TempWorkspace::new("rollback");
        let state = workspace.state();
        state.initialize().expect("initialize database");

        {
            let connection = state.lock_connection().expect("lock connection");
            connection
                .as_ref()
                .expect("connection is initialized")
                .execute(
                    "INSERT INTO collections (id, name, sort_order, created_at)
                     VALUES ('existing', 'Recipes', 0, '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .expect("seed conflicting collection");
        }

        let result = state.complete_setup(setup_input(&["Recipes"], Some(VERIFIER)));
        assert!(result.is_err(), "duplicate collection must fail setup");

        let connection = Connection::open(workspace.database_path()).expect("reopen database");

        let setup_completed_at: Option<String> = connection
            .query_row(
                "SELECT (SELECT setup_completed_at FROM profile WHERE id = 1)",
                [],
                |row| row.get(0),
            )
            .expect("read completion timestamp");
        assert!(setup_completed_at.is_none());

        assert_eq!(row_count(&connection, "profile"), 0);
        assert_eq!(row_count(&connection, "preferences"), 0);
        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Onboarding
        );
    }

    #[test]
    fn complete_setup_rejects_blank_names_and_keeps_the_database_untouched() {
        let workspace = TempWorkspace::new("validation");
        let state = workspace.state();
        state.initialize().expect("initialize database");

        let mut blank_owner = setup_input(&[], None);
        blank_owner.owner_name = "   ".to_string();
        assert!(state.complete_setup(blank_owner).is_err());

        let blank_collection = setup_input(&["   "], None);
        assert!(state.complete_setup(blank_collection).is_err());

        let connection = Connection::open(workspace.database_path()).expect("reopen database");
        assert_eq!(row_count(&connection, "profile"), 0);
    }

    #[test]
    fn validate_setup_rejects_duplicate_collection_names_without_sql_error_text() {
        let duplicate = setup_input(&["Projects", "  Projects  "], None);
        let error = validate_setup(&duplicate).expect_err("duplicate names are rejected");

        assert!(
            !error.to_uppercase().contains("UNIQUE"),
            "leaked SQL: {error}"
        );
        assert!(
            !error.to_uppercase().contains("CONSTRAINT"),
            "leaked SQL: {error}"
        );

        // SQLite's default UNIQUE comparison is case sensitive, so these are distinct.
        let case_distinct = setup_input(&["Drafts", "drafts"], None);
        assert!(validate_setup(&case_distinct).is_ok());
    }

    #[test]
    fn complete_setup_rejects_duplicate_collection_names_before_writing() {
        let workspace = TempWorkspace::new("duplicate-collections");
        let state = workspace.state();
        state.initialize().expect("initialize database");

        let error = state
            .complete_setup(setup_input(&["Projects", " Projects "], None))
            .expect_err("duplicate collection names must fail setup");

        assert!(
            !error.to_uppercase().contains("UNIQUE"),
            "leaked SQL: {error}"
        );
        assert!(
            !error.to_uppercase().contains("CONSTRAINT"),
            "leaked SQL: {error}"
        );

        let connection = Connection::open(workspace.database_path()).expect("reopen database");
        assert_eq!(row_count(&connection, "profile"), 0);
    }

    #[test]
    fn save_profile_falls_back_to_a_generated_vault_name() {
        let mut connection = migrated_memory_database();
        write_setup(&mut connection, &setup_input(&[], None)).expect("write setup");

        write_profile(
            &mut connection,
            &ProfileInput {
                owner_name: "  Ada  ".to_string(),
                vault_name: "   ".to_string(),
            },
        )
        .expect("save profile with a blank vault name");

        let profile = read_profile(&connection).expect("read profile");
        assert_eq!(profile.owner_name, "Ada");
        assert_eq!(profile.vault_name, "Ada's Vault");
    }

    #[test]
    fn save_profile_still_rejects_a_blank_owner_name() {
        let workspace = TempWorkspace::new("blank-owner");
        let state = workspace.state();
        state.initialize().expect("initialize database");
        state
            .complete_setup(setup_input(&[], None))
            .expect("complete setup");

        let error = state
            .save_profile(&ProfileInput {
                owner_name: "   ".to_string(),
                vault_name: "Any Vault".to_string(),
            })
            .expect_err("blank owner name must be rejected");

        assert!(
            error.contains("Owner name is required"),
            "unexpected: {error}"
        );
    }

    #[test]
    fn set_password_verifier_stores_and_overwrites_the_stored_verifier() {
        let mut connection = migrated_memory_database();
        write_setup(&mut connection, &setup_input(&[], None)).expect("write setup");

        write_password_verifier(&mut connection, VERIFIER).expect("set verifier");
        assert_eq!(
            read_password_verifier(&connection)
                .expect("read verifier")
                .as_deref(),
            Some(VERIFIER)
        );
        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Locked
        );

        let replacement = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdAyb3RoZXI$aGFzaA";
        write_password_verifier(&mut connection, replacement).expect("overwrite verifier");

        assert_eq!(
            read_password_verifier(&connection)
                .expect("read verifier")
                .as_deref(),
            Some(replacement)
        );
    }

    #[test]
    fn remove_password_verifier_clears_the_stored_verifier() {
        let mut connection = migrated_memory_database();
        write_setup(&mut connection, &setup_input(&[], Some(VERIFIER))).expect("write setup");
        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Locked
        );

        clear_password_verifier(&mut connection).expect("clear verifier");

        assert_eq!(
            read_password_verifier(&connection).expect("read verifier"),
            None
        );
        assert_eq!(
            read_boot_state(&connection).expect("read boot state"),
            BootState::Ready
        );
    }

    #[test]
    fn validate_verifier_accepts_argon2id_and_rejects_blank_or_foreign_values() {
        let valid = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA";

        assert_eq!(validate_verifier(valid), Ok(valid));
        assert_eq!(validate_verifier(&format!("  {valid}  ")), Ok(valid));

        assert!(validate_verifier("").is_err());
        assert!(validate_verifier("   ").is_err());
        assert!(validate_verifier("not-a-phc-string").is_err());
        assert!(validate_verifier("$pbkdf2-sha256$i=600000,l=32$c2FsdA$aGFzaA").is_err());
        assert!(validate_verifier("$argon2id$not-really-a-phc").is_err());
        assert!(validate_verifier("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA").is_err());
    }

    #[test]
    fn validate_verifier_accepts_a_freshly_hashed_argon2id_password() {
        let verifier = crate::security::hash_password("correct horse battery staple".to_string())
            .expect("hash password");

        assert_eq!(validate_verifier(&verifier), Ok(verifier.as_str()));
    }

    #[test]
    fn database_state_sets_and_removes_the_verifier_for_boot_states() {
        let valid = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA";
        let workspace = TempWorkspace::new("verifier-state");
        let state = workspace.state();
        state.initialize().expect("initialize database");
        state
            .complete_setup(setup_input(&[], None))
            .expect("complete setup");

        state.set_password_verifier(valid).expect("set verifier");

        {
            let connection = Connection::open(workspace.database_path()).expect("reopen database");
            assert_eq!(
                connection
                    .query_row(
                        "SELECT password_verifier FROM security WHERE id = 1",
                        [],
                        |row| { row.get::<_, Option<String>>(0) }
                    )
                    .expect("read verifier")
                    .as_deref(),
                Some(valid)
            );
        }

        assert_eq!(
            state.boot_state().expect("read boot state"),
            BootState::Locked
        );

        state.remove_password_verifier().expect("remove verifier");

        assert_eq!(state.password_verifier().expect("read verifier"), None);
        assert_eq!(
            state.boot_state().expect("read boot state"),
            BootState::Ready
        );
    }

    #[test]
    fn set_password_verifier_rejects_invalid_input_without_writing() {
        let workspace = TempWorkspace::new("verifier-validation");
        let state = workspace.state();
        state.initialize().expect("initialize database");
        state
            .complete_setup(setup_input(&[], None))
            .expect("complete setup");

        for invalid in [
            "",
            "   ",
            "not-a-phc-string",
            "$pbkdf2-sha256$i=1$c2FsdA$aGFzaA",
        ] {
            let error = state
                .set_password_verifier(invalid)
                .expect_err("invalid verifier must be rejected");

            assert!(
                !error.contains("argon2id$v="),
                "error must not echo the verifier"
            );
        }

        assert!(state.password_verifier().expect("read verifier").is_none());
    }
}
