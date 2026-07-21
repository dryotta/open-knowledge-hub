/** Fixed identity used for both forward and reverse wiki commits.
 *
 * It gives CI runners (which have no default git identity for our ad-hoc clones)
 * a committer, and — crucially — a reliable marker: reverse sync diffs against
 * the most recent wiki commit by this identity, so a forward push never triggers
 * a reverse loop.
 */
export const WIKI_BOT_NAME = "OKH Wiki Bot";
export const WIKI_BOT_EMAIL = "okh-wiki-bot@users.noreply.github.com";

/** Gollum special files — global chrome, regenerated on every publish. Never
 * treated as concept content by reverse sync. */
export const WIKI_CHROME = new Set(["_Header.md", "_Footer.md", "_Sidebar.md"]);
