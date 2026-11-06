/**
 * A connection as a profile's preview card shows it: its name and what
 * identifies it at a glance. Main reads these for any profile without
 * decrypting anything.
 */
export interface ProfileConnection {
  name: string;
  /** The registry's icon, when the connection was installed from it. */
  iconUrl?: string;
  /** The server's address, for a favicon when there is no icon. */
  url?: string;
}
