// saw's official documentation, which the extension points to for what saw does and why.
const SAW_DOCS = "https://saw-docs.ndevuspace.com/latest/";

export const DOCS = {
  home: "https://saw-docs.ndevuspace.com/",
  verdicts: `${SAW_DOCS}explanation/verdicts/`,
  fix: `${SAW_DOCS}reference/cli/fix/`,
  audit: `${SAW_DOCS}how-to/audit-a-machine/`,
  hooks: `${SAW_DOCS}how-to/scan-on-clone/`,
  configuration: `${SAW_DOCS}reference/configuration/`,
} as const;
