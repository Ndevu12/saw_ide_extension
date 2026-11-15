// The commands git ships with. git never runs an alias in place of one of these, so the stand-in
// does not look them up as aliases. Data only: add a command here when a git release adds one.

export const GIT_BUILTINS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr", "check-ignore",
  "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick", "clean", "clone", "column", "commit",
  "commit-graph", "commit-tree", "config", "count-objects", "credential", "describe", "diff", "diff-files", "diff-index", "diff-tree",
  "difftool", "fetch", "for-each-ref", "format-patch", "fsck", "gc", "grep", "hash-object", "help", "init", "interpret-trailers",
  "log", "ls-files", "ls-remote", "ls-tree", "maintenance", "merge", "merge-base", "merge-file", "mergetool", "mktag", "mktree", "mv",
  "name-rev", "notes", "prune", "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "remote", "repack", "replace", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch", "show-ref", "sparse-checkout", "stash",
  "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref", "var", "verify-commit", "verify-pack",
  "verify-tag", "version", "whatchanged", "worktree", "write-tree",
]);
