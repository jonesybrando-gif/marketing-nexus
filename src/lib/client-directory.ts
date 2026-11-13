/** Cookie remembering the Clients page layout, so the server renders the chosen one with no flash. */
export const CLIENTS_VIEW_COOKIE = "mn_clients_layout";

export type DirectoryLayout = "grid" | "list";

/** Grid unless the cookie says list. */
export const parseLayout = (v: string | undefined): DirectoryLayout => (v === "list" ? "list" : "grid");
