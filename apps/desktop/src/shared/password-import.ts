/**
 * Importing a password manager's file (ADR 0201): a CSV export, a
 * Bitwarden JSON export, or a KeePass database. A database asks for its
 * password first; main holds the file under a short-lived token until
 * the person unlocks it or gives up, so its contents never reach the
 * renderer.
 */
export type PasswordFileImportResult =
  | { status: "cancelled" }
  | {
      status: "imported";
      passwords: number;
      passkeys: number;
      /** Already saved in this profile, so left as they are. */
      existing: number;
      /** Items with neither a website login nor a passkey Work can use. */
      skipped: number;
    }
  | {
      /** A KeePass database: unlock it with `passwordFileUnlock`. */
      status: "locked";
      token: string;
      name: string;
      keyFile: string | null;
      /** The last password or key file did not open it. */
      wrongKey: boolean;
    }
  | { status: "failed"; message: string };
