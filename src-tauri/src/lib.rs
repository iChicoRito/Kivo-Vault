mod backup;
mod database;
mod device_unlock;
mod duplicates;
mod encryption;
mod health;
mod icons;
mod insights;
mod key_slots;
mod link_details;
mod passwords;
mod portability;
mod recovery;
mod security;
mod selective_restore;
mod vault;
mod vaults;

/// Lives here because it touches both backup and the password vault, and the
/// integration tests compile `backup.rs` without `passwords.rs`.
#[tauri::command]
fn restore_backup(
    path: String,
    password: Option<String>,
    recovery_key: Option<String>,
    state: tauri::State<'_, database::DatabaseState>,
    vault: tauri::State<'_, passwords::VaultKeyState>,
) -> Result<backup::RestoreSummary, String> {
    // The restored database has its own vault keys, so the old key must not stay loaded.
    vault.clear();
    state.check_attempt()?;
    let unlock = match (&recovery_key, &password) {
        (Some(kit), _) => Some(backup::BackupUnlock::Recovery(kit)),
        (None, Some(password)) => Some(backup::BackupUnlock::Password(password)),
        (None, None) => None,
    };
    let result = backup::restore_with_unlock(state.inner(), std::path::Path::new(&path), unlock.as_ref());
    let wrong = matches!(&result, Err(error) if error.starts_with("That Master Password") || error.starts_with("That recovery key"));
    if wrong || result.is_ok() {
        state.record_attempt(!wrong);
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;

            // Decrypted copies left by the last session must not outlive it.
            encryption::clear_temp_files();

            let data_dir = app.path().app_local_data_dir()?;
            let registry = vaults::read_registry(&data_dir);
            let root = vaults::startup_root(&data_dir, registry.as_ref());
            let database = database::DatabaseState::new(root.join("kivo.db"), root.join("files"));
            // Files staged for an import decision must not outlive the session.
            let _ = std::fs::remove_dir_all(database.staging_dir());

            // Try migration during startup. Failed attempts remain retryable through the command.
            let _ = database.initialize();
            app.manage(database);
            app.manage(vaults::VaultsState::new(data_dir, registry, &root));
            app.manage(passwords::VaultKeyState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::initialize_database,
            vaults::list_vaults,
            vaults::switch_vault,
            vaults::create_vault,
            database::load_boot_state,
            database::complete_setup,
            database::load_profile,
            database::save_profile,
            database::load_preferences,
            database::save_preferences,
            database::set_password_verifier,
            database::remove_password_verifier,
            database::load_password_verifier,
            database::has_password_verifier,
            passwords::reset_requires_password,
            passwords::reset_vault,
            passwords::verify_reset_password,
            security::hash_password,
            security::verify_password,
            encryption::read_protection_state,
            encryption::unlock_content_vault,
            encryption::lock_content_vault,
            encryption::enable_encryption,
            encryption::disable_encryption,
            encryption::change_master_password,
            backup::pick_backup_destination,
            backup::create_backup,
            backup::create_backup_now,
            backup::pick_backup_source,
            backup::inspect_backup,
            restore_backup,
            portability::pick_save_file,
            portability::pick_folder_destination,
            portability::export_note_markdown,
            portability::export_items_json,
            portability::export_vault_json,
            portability::import_json,
            portability::import_markdown,
            vault::import_file,
            vault::preview_file_import,
            vault::commit_file_import,
            vault::cancel_file_import,
            vault::index_file,
            vault::save_item,
            vault::load_item,
            vault::list_items,
            vault::set_item_tags,
            vault::list_collections,
            vault::list_item_versions,
            vault::restore_item_version,
            vault::read_item_file,
            vault::load_storage_report,
            vault::list_index_state,
            vault::set_item_pinned,
            vault::set_items_favorite,
            vault::move_items_to_collection,
            vault::trash_items,
            vault::restore_items,
            vault::delete_items_permanently,
            vault::load_vault_summary,
            vault::save_collection,
            vault::delete_collection,
            vault::verify_collection_secret,
            vault::lock_collection,
            vault::list_tags,
            vault::pick_file,
            vault::pick_files,
            vault::open_item_file,
            vault::reveal_item_file,
            vault::open_source_url,
            insights::search_related_items,
            insights::reindex_items,
            insights::suggest_tags,
            insights::summarize_item,
            icons::credential_icon,
            link_details::fetch_link_details,
            passwords::vault_status,
            passwords::setup_vault,
            passwords::unlock_vault,
            passwords::lock_vault,
            passwords::change_password_vault_password,
            recovery::read_recovery_status,
            recovery::begin_recovery_setup,
            recovery::save_recovery_kit,
            recovery::confirm_recovery_setup,
            recovery::cancel_recovery_setup,
            recovery::disable_recovery,
            recovery::recover_vault,
            device_unlock::read_device_unlock_status,
            device_unlock::enroll_device_unlock,
            device_unlock::unlock_with_device,
            device_unlock::disable_device_unlock,
            passwords::list_credentials,
            passwords::load_credential,
            passwords::save_credential,
            passwords::list_credential_versions,
            passwords::restore_credential_version,
            passwords::pick_password_csv,
            passwords::preview_password_import,
            passwords::import_credentials,
            health::check_vault_health,
            health::repair_vault_health,
            selective_restore::list_backup_contents,
            selective_restore::restore_from_backup,
            passwords::set_credentials_favorite,
            passwords::trash_credentials,
            passwords::restore_credentials,
            passwords::delete_credentials_permanently,
            passwords::copy_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kivo")
}
