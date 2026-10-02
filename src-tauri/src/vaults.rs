use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database::DatabaseState;

/// The list of vaults, kept next to (not inside) the vault databases so the
/// names can be shown while every vault is locked.
const REGISTRY_FILE: &str = "vaults.json";
const VAULTS_DIR: &str = "vaults";
const DEFAULT_NAME: &str = "My Vault";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub name: String,
    /// The vault that existed before multi-vault support. Its files stay in
    /// the app data folder itself; every other vault lives in `vaults/<id>`.
    #[serde(default)]
    pub legacy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub active_id: String,
    pub vaults: Vec<VaultEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultList {
    pub active_id: String,
    pub vaults: Vec<VaultSummary>,
}

pub struct VaultsState {
    data_dir: PathBuf,
    // `None` until the open database could be read once to register the
    // existing vault.
    registry: Mutex<Option<Registry>>,
}

impl Registry {
    fn entry(&self, id: &str) -> Option<&VaultEntry> {
        self.vaults.iter().find(|vault| vault.id == id)
    }
}

pub fn vault_root(data_dir: &Path, entry: &VaultEntry) -> PathBuf {
    if entry.legacy {
        data_dir.to_path_buf()
    } else {
        data_dir.join(VAULTS_DIR).join(&entry.id)
    }
}

pub fn read_registry(data_dir: &Path) -> Option<Registry> {
    let text = fs::read_to_string(data_dir.join(REGISTRY_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_registry(data_dir: &Path, registry: &Registry) -> Result<(), String> {
    let text = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    let target = data_dir.join(REGISTRY_FILE);
    let partial = data_dir.join(format!("{REGISTRY_FILE}.partial"));
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    fs::write(&partial, text).map_err(|error| format!("Could not save the vault list: {error}"))?;
    fs::rename(&partial, &target).map_err(|error| format!("Could not save the vault list: {error}"))
}

/// Folder to open at startup: the active vault, or the first vault whose
/// database still exists. Without a registry this is the app data folder.
pub fn startup_root(data_dir: &Path, registry: Option<&Registry>) -> PathBuf {
    let Some(registry) = registry else {
        return data_dir.to_path_buf();
    };
    let exists = |entry: &VaultEntry| vault_root(data_dir, entry).join("kivo.db").is_file();
    registry
        .entry(&registry.active_id)
        .filter(|entry| exists(entry))
        .or_else(|| registry.vaults.iter().find(|entry| exists(entry)))
        .or_else(|| registry.entry(&registry.active_id))
        .map(|entry| vault_root(data_dir, entry))
        .unwrap_or_else(|| data_dir.to_path_buf())
}

fn read_uid(connection: &Connection) -> Result<String, String> {
    connection
        .query_row("SELECT uid FROM vault_identity WHERE id = 1", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the vault identity: {error}"))
}

/// The vault name saved in the profile, if setup has finished.
fn read_name(connection: &Connection) -> Option<String> {
    crate::database::read_profile(connection)
        .ok()
        .map(|profile| profile.vault_name.trim().to_string())
        .filter(|name| !name.is_empty())
}

impl VaultsState {
    /// `opened` is the folder startup actually opened; the active vault is
    /// set to match it in case the saved one was missing.
    pub fn new(data_dir: PathBuf, mut registry: Option<Registry>, opened: &Path) -> Self {
        if let Some(registry) = registry.as_mut() {
            if let Some(entry) = registry
                .vaults
                .iter()
                .find(|entry| vault_root(&data_dir, entry) == opened)
            {
                registry.active_id = entry.id.clone();
            }
        }
        Self {
            data_dir,
            registry: Mutex::new(registry),
        }
    }

    /// The registry, created on first use from the open database: the vault
    /// that existed before becomes the first entry, with all its contents.
    fn with_registry<T>(
        &self,
        database: &DatabaseState,
        action: impl FnOnce(&mut Registry) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut stored = self
            .registry
            .lock()
            .map_err(|_| "Vault list lock is poisoned".to_string())?;
        if stored.is_none() {
            let connection = database.require_connection()?;
            let connection = connection.as_ref().expect("checked above");
            let registry = Registry {
                active_id: read_uid(connection)?,
                vaults: vec![VaultEntry {
                    id: read_uid(connection)?,
                    name: read_name(connection).unwrap_or_else(|| DEFAULT_NAME.to_string()),
                    legacy: true,
                }],
            };
            write_registry(&self.data_dir, &registry)?;
            *stored = Some(registry);
        }
        action(stored.as_mut().expect("set above"))
    }

    pub fn list(&self, database: &DatabaseState) -> Result<VaultList, String> {
        self.with_registry(database, |registry| {
            // A rename in Settings changes the profile; keep the list in step.
            let current = database
                .require_connection()
                .ok()
                .and_then(|connection| read_name(connection.as_ref().expect("checked above")));
            let active_id = registry.active_id.clone();
            if let Some(name) = current {
                if let Some(entry) = registry.vaults.iter_mut().find(|entry| entry.id == active_id) {
                    if entry.name != name {
                        entry.name = name;
                        write_registry(&self.data_dir, registry)?;
                    }
                }
            }
            Ok(VaultList {
                active_id,
                vaults: registry
                    .vaults
                    .iter()
                    .map(|entry| VaultSummary {
                        id: entry.id.clone(),
                        name: entry.name.clone(),
                    })
                    .collect(),
            })
        })
    }

    /// Opens another vault. The vault that was open is locked: its content
    /// key, opened collections and staged work are dropped by `open_root`.
    pub fn switch(&self, database: &DatabaseState, id: &str) -> Result<(), String> {
        self.with_registry(database, |registry| {
            let entry = registry
                .entry(id)
                .cloned()
                .ok_or_else(|| "That vault no longer exists".to_string())?;
            self.open_entry(database, registry, &entry)
        })
    }

    fn open_entry(
        &self,
        database: &DatabaseState,
        registry: &mut Registry,
        entry: &VaultEntry,
    ) -> Result<(), String> {
        let previous = registry
            .entry(&registry.active_id)
            .map(|entry| vault_root(&self.data_dir, entry));
        if let Err(error) = database.open_root(&vault_root(&self.data_dir, entry)) {
            // Never leave the app without a database.
            if let Some(previous) = previous {
                let _ = database.open_root(&previous);
            }
            return Err(error);
        }
        registry.active_id = entry.id.clone();
        write_registry(&self.data_dir, registry)
    }

    /// Creates an empty vault in its own folder and opens it. Setup (owner,
    /// Master Password, starter collections) follows through `complete_setup`.
    pub fn create(&self, database: &DatabaseState, name: &str) -> Result<VaultSummary, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Enter a name for the vault.".to_string());
        }
        self.with_registry(database, |registry| {
            if registry
                .vaults
                .iter()
                .any(|vault| vault.name.to_lowercase() == name.to_lowercase())
            {
                return Err("A vault with that name already exists.".to_string());
            }
            let mut bytes = [0u8; 16];
            getrandom::getrandom(&mut bytes).map_err(|_| "Could not create the vault".to_string())?;
            let entry = VaultEntry {
                id: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
                name: name.to_string(),
                legacy: false,
            };
            let root = vault_root(&self.data_dir, &entry);

            let prepared = prepare_vault(&root, &entry.id).and_then(|()| {
                registry.vaults.push(entry.clone());
                self.open_entry(database, registry, &entry)
            });
            if let Err(error) = prepared {
                registry.vaults.retain(|vault| vault.id != entry.id);
                let _ = write_registry(&self.data_dir, registry);
                let _ = fs::remove_dir_all(&root);
                return Err(error);
            }
            Ok(VaultSummary {
                id: entry.id,
                name: entry.name,
            })
        })
    }
}

/// Creates the new vault's database and gives it the registry id, so the
/// list and the vault's own backups agree on which vault it is.
fn prepare_vault(root: &Path, id: &str) -> Result<(), String> {
    let state = DatabaseState::new(root.join("kivo.db"), root.join("files"));
    state.initialize()?;
    let connection = state.require_connection()?;
    connection
        .as_ref()
        .expect("checked above")
        .execute("UPDATE vault_identity SET uid = ?1 WHERE id = 1", [id])
        .map_err(|error| format!("Could not create the vault: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_vaults(
    vaults: State<'_, VaultsState>,
    database: State<'_, DatabaseState>,
) -> Result<VaultList, String> {
    vaults.list(database.inner())
}

#[tauri::command]
pub fn switch_vault(
    id: String,
    vaults: State<'_, VaultsState>,
    database: State<'_, DatabaseState>,
    passwords: State<'_, crate::passwords::VaultKeyState>,
) -> Result<(), String> {
    // The Password Manager key belongs to the vault being left.
    passwords.clear();
    vaults.switch(database.inner(), &id)
}

#[tauri::command]
pub fn create_vault(
    name: String,
    vaults: State<'_, VaultsState>,
    database: State<'_, DatabaseState>,
    passwords: State<'_, crate::passwords::VaultKeyState>,
) -> Result<VaultSummary, String> {
    let created = vaults.create(database.inner(), &name)?;
    // The Password Manager key belongs to the vault that was left.
    passwords.clear();
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{read_boot_state, write_setup, BootState, SetupInput};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct DataDir(PathBuf);

    impl DataDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("kivo-vaults-{label}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&root).expect("create data dir");
            Self(root)
        }
    }

    impl Drop for DataDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open(root: &Path) -> DatabaseState {
        let state = DatabaseState::new(root.join("kivo.db"), root.join("files"));
        state.initialize().expect("initialize");
        state
    }

    fn setup(state: &DatabaseState, vault_name: &str, collection: &str) {
        let mut connection = state.require_connection().expect("connection");
        write_setup(
            connection.as_mut().expect("open"),
            &SetupInput {
                owner_name: "Ana".to_string(),
                vault_name: vault_name.to_string(),
                starter_collections: vec![collection.to_string()],
                password_verifier: None,
            },
        )
        .expect("setup");
    }

    fn add_records(state: &DatabaseState, word: &str, theme: &str) {
        let connection = state.require_connection().expect("connection");
        let connection = connection.as_ref().expect("open");
        let tags = format!("[\"{word}-tag\"]");
        connection
            .execute(
                "INSERT INTO items (id, kind, title, description, content, url, collection_id,
                   is_favorite, is_pinned, tags, created_at, updated_at)
                 VALUES (?1 || '-item', 'note', ?1 || ' note', '', ?1 || ' body', NULL, NULL,
                   0, 0, ?2, 'now', 'now')",
                rusqlite::params![word, tags],
            )
            .expect("insert item");
        connection
            .execute(
                "INSERT INTO item_search (item_id, kind, title, body)
                 VALUES (?1 || '-item', 'note', ?1 || ' note', ?1 || ' body')",
                [word],
            )
            .expect("index item");
        connection
            .execute(
                "INSERT INTO credentials (id, service, password_nonce, password_ciphertext,
                   created_at, updated_at)
                 VALUES (?1 || '-login', ?1 || ' site', x'00', x'00', 'now', 'now')",
                [word],
            )
            .expect("insert credential");
        connection
            .execute("UPDATE preferences SET theme = ?1 WHERE id = 1", [theme])
            .expect("set theme");
    }

    /// Everything a vault can hold, as one comparable snapshot.
    fn contents(state: &DatabaseState) -> Vec<String> {
        let connection = state.require_connection().expect("connection");
        let connection = connection.as_ref().expect("open");
        let column = |sql: &str| -> Vec<String> {
            let mut statement = connection.prepare(sql).expect("prepare");
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("rows")
        };
        let mut all = Vec::new();
        all.extend(column("SELECT 'item:' || title FROM items ORDER BY id"));
        all.extend(column("SELECT 'tags:' || tags FROM items ORDER BY id"));
        all.extend(column("SELECT 'collection:' || name FROM collections ORDER BY name"));
        all.extend(column("SELECT 'login:' || service FROM credentials ORDER BY id"));
        all.extend(column("SELECT 'theme:' || theme FROM preferences"));
        all
    }

    fn search(state: &DatabaseState, word: &str) -> Vec<String> {
        let connection = state.require_connection().expect("connection");
        let connection = connection.as_ref().expect("open");
        let mut statement = connection
            .prepare("SELECT item_id FROM item_search WHERE item_search MATCH ?1")
            .expect("prepare");
        statement
            .query_map([word], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows")
    }

    fn boot(state: &DatabaseState) -> BootState {
        let connection = state.require_connection().expect("connection");
        read_boot_state(connection.as_ref().expect("open")).expect("boot state")
    }

    /// Two registered vaults: the existing one in the data folder and a
    /// second one under `vaults/second`.
    fn two_vaults(data: &DataDir) -> (DatabaseState, VaultsState) {
        let state = open(&data.0);
        setup(&state, "Work", "Projects");
        add_records(&state, "alpha", "light");
        let vaults = VaultsState::new(data.0.clone(), None, &data.0);
        vaults.list(&state).expect("register existing vault");

        let other = open(&data.0.join(VAULTS_DIR).join("second"));
        setup(&other, "Home", "Recipes");
        add_records(&other, "beta", "dark");
        drop(other);

        let mut registry = read_registry(&data.0).expect("registry saved");
        registry.vaults.push(VaultEntry {
            id: "second".to_string(),
            name: "Home".to_string(),
            legacy: false,
        });
        write_registry(&data.0, &registry).expect("save registry");
        (state, VaultsState::new(data.0.clone(), Some(registry), &data.0))
    }

    #[test]
    fn existing_vault_becomes_first_entry_with_its_contents() {
        let data = DataDir::new("legacy");
        let state = open(&data.0);
        setup(&state, "Work", "Projects");
        add_records(&state, "alpha", "light");
        let before = contents(&state);

        let vaults = VaultsState::new(data.0.clone(), None, &data.0);
        let list = vaults.list(&state).expect("list");

        assert_eq!(list.vaults.len(), 1);
        assert_eq!(list.vaults[0].name, "Work");
        assert_eq!(list.active_id, list.vaults[0].id);
        assert!(read_registry(&data.0).expect("registry written").vaults[0].legacy);
        assert_eq!(contents(&state), before, "nothing moved or changed");
        assert!(data.0.join("kivo.db").is_file());
    }

    #[test]
    fn vaults_never_see_each_others_contents_or_search_hits() {
        let data = DataDir::new("isolation");
        let (state, vaults) = two_vaults(&data);
        let first = contents(&state);
        let legacy = vaults.list(&state).expect("list").active_id;

        vaults.switch(&state, "second").expect("switch to second");
        assert_eq!(
            contents(&state),
            vec![
                "item:beta note",
                "tags:[\"beta-tag\"]",
                "collection:Recipes",
                "login:beta site",
                "theme:dark",
            ]
        );
        assert!(search(&state, "alpha").is_empty());
        assert_eq!(search(&state, "beta"), vec!["beta-item"]);

        vaults.switch(&state, &legacy).expect("switch back");
        assert_eq!(contents(&state), first);
        assert!(first.iter().all(|entry| !entry.contains("beta") && !entry.contains("Recipes")));
        assert!(search(&state, "beta").is_empty());
        assert_eq!(vaults.list(&state).expect("list").active_id, legacy);
    }

    #[test]
    fn switching_locks_the_vault_that_was_left() {
        let data = DataDir::new("relock");
        let (state, vaults) = two_vaults(&data);
        {
            // Give the second vault its own Master Password.
            let other = open(&data.0.join(VAULTS_DIR).join("second"));
            let verifier = crate::security::hash_secret("second-pass").expect("hash");
            let connection = other.require_connection().expect("connection");
            connection
                .as_ref()
                .expect("open")
                .execute("UPDATE security SET password_verifier = ?1 WHERE id = 1", [verifier])
                .expect("set verifier");
        }
        state.content_key().store([7; 32]).expect("store key");
        state.unlock_collection("projects");
        let generation = state.session_generation();

        vaults.switch(&state, "second").expect("switch");

        assert!(state.content_key().require_key().is_err(), "content key dropped");
        assert!(!state.is_collection_unlocked("projects"));
        assert!(state.session_generation() > generation);
        assert!(matches!(boot(&state), BootState::Locked));
    }

    #[test]
    fn unknown_vault_is_refused_and_open_vault_stays() {
        let data = DataDir::new("unknown");
        let (state, vaults) = two_vaults(&data);
        let before = contents(&state);

        let error = vaults.switch(&state, "missing").expect_err("refused");

        assert_eq!(error, "That vault no longer exists");
        assert_eq!(contents(&state), before);
    }

    #[test]
    fn startup_opens_the_active_vault_or_falls_back() {
        let data = DataDir::new("startup");
        let (state, vaults) = two_vaults(&data);
        vaults.switch(&state, "second").expect("switch");
        drop(state);

        let registry = read_registry(&data.0).expect("registry");
        assert_eq!(registry.active_id, "second");
        assert_eq!(startup_root(&data.0, Some(&registry)), data.0.join(VAULTS_DIR).join("second"));

        fs::remove_dir_all(data.0.join(VAULTS_DIR)).expect("remove second vault");
        assert_eq!(startup_root(&data.0, Some(&registry)), data.0);
        let legacy = registry.vaults.iter().find(|entry| entry.legacy).expect("legacy").id.clone();
        let vaults = VaultsState::new(data.0.clone(), Some(registry), &data.0);
        let state = open(&data.0);
        assert_eq!(vaults.list(&state).expect("list").active_id, legacy);
    }

    fn count(state: &DatabaseState, table: &str) -> i64 {
        let connection = state.require_connection().expect("connection");
        connection
            .as_ref()
            .expect("open")
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .expect("count")
    }

    #[test]
    fn new_vault_starts_empty_and_private_and_opens() {
        let data = DataDir::new("create");
        let (state, vaults) = two_vaults(&data);
        let legacy = vaults.list(&state).expect("list").active_id;
        let first = contents(&state);

        let created = vaults.create(&state, "  Travel  ").expect("create");

        assert_eq!(created.name, "Travel");
        let list = vaults.list(&state).expect("list");
        assert_eq!(list.active_id, created.id);
        assert_eq!(list.vaults.len(), 3);
        assert!(data.0.join(VAULTS_DIR).join(&created.id).join("kivo.db").is_file());
        for table in ["items", "collections", "credentials", "vault_keys", "vault_key_slots", "profile"] {
            assert_eq!(count(&state, table), 0, "{table} is empty");
        }
        assert!(matches!(boot(&state), BootState::Onboarding));
        let connection = state.require_connection().expect("connection");
        let uid: String = connection
            .as_ref()
            .expect("open")
            .query_row("SELECT uid FROM vault_identity", [], |row| row.get(0))
            .expect("uid");
        drop(connection);
        assert_eq!(uid, created.id, "database knows which vault it is");

        // Setup gives it only the chosen collections and its own password.
        {
            let verifier = crate::security::hash_secret("travel-pass").expect("hash");
            let mut connection = state.require_connection().expect("connection");
            write_setup(
                connection.as_mut().expect("open"),
                &SetupInput {
                    owner_name: "Ana".to_string(),
                    vault_name: "Travel".to_string(),
                    starter_collections: vec!["Images & Media".to_string()],
                    password_verifier: Some(verifier),
                },
            )
            .expect("setup");
        }
        assert_eq!(contents(&state), vec!["collection:Images & Media", "theme:dark"]);
        assert!(matches!(boot(&state), BootState::Locked));

        vaults.switch(&state, &legacy).expect("back to the first vault");
        assert_eq!(contents(&state), first, "the first vault is unchanged");
        assert!(matches!(boot(&state), BootState::Ready), "its password did not change");
    }

    #[test]
    fn new_vault_needs_a_unique_name() {
        let data = DataDir::new("create-name");
        let (state, vaults) = two_vaults(&data);

        assert_eq!(vaults.create(&state, "   ").expect_err("empty"), "Enter a name for the vault.");
        assert_eq!(
            vaults.create(&state, "home").expect_err("taken"),
            "A vault with that name already exists."
        );
        assert_eq!(vaults.list(&state).expect("list").vaults.len(), 2);
        assert!(!data.0.join(VAULTS_DIR).read_dir().expect("vaults dir").any(|entry| {
            entry.expect("entry").file_name() != "second"
        }));
    }
}
