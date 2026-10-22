# Decisions during a fix

A fix still starts from an infected folder, after the confirmation that names what saw will change.
When saw reaches something only the operator can decide, the decision is made in the editor. The
saw sidebar says what is being asked and offers the actions. The editor shows the evidence as a
diff, the same way **Open Changes** shows a finished clean-up.

saw asks these questions only while fixing one local folder. A delivery and a known-malicious
package are asked by `saw fix`, which is the command **Fix…** runs. A file saw will not decide is
asked by `saw fix amend`, because those answers rewrite history, and **Fix…** does not. The
extension asks them when `saw capabilities --json` announces `fix.ask.json` at schema `fix-ask`
version 1, and then passes `--ask=jsonl`. A saw without that feature is not given the flag: the
fix finishes, and anything saw would have asked is left in the report. What saw has to provide is
[stayAwakeBot#1847](https://github.com/Ndevu12/stayAwakeBot/issues/1847).

## While a fix is waiting

The folder's row in the Verdict view changes from "fixing…" to "waiting for you", and the saw
sidebar shows a **Decide** section for that folder. The diff opens on its own. The same actions
are in the Decide section and in the toolbar of that diff.

Keep, and Leave it declared, are the focused actions. Remove, Take out, and Restore are chosen
on purpose. One question is open at a time. Under it, the panel lists what was already decided in
this fix, in the operator's words: kept a path, will remove a path.

Closing the diff does not answer. **Show diff** opens it again. Closing the sidebar does not
answer either. When the saw view is hidden, a notification says saw is waiting and offers
**Show**. **Stop** cancels the fix as it does today: the fix ends, the folder is scanned again,
and the open question is not taken as a Keep.

## A file saw will not decide

This question is `saw fix amend`. The diff title carries the warning, because the file's own
words can lie. It reads "saw is unsure about this file", or, when saw has confirmed the file and
could not clean it, "saw confirmed this file". The sidebar gives the path, the kind of finding, why it is there, and the origin: the
commit it arrived in and the files from that commit saw is already removing, or that git could
not read the origin.

| What saw knows | What opens |
| --- | --- |
| An earlier clean version | A side-by-side diff. The left side is "Clean version from `<commit>`". The right side is "In the folder now". **Restore** takes the left side. |
| No clean version | The file, read-only, in one editor. |
| **Supply a file** | A file picker, then a second diff, "Your file ↔ In the folder now", and **Use this file** before the answer is sent. A file chosen from inside the folder being fixed is marked as such on that diff. |
| Binary, unreadable, or a kind of file saw does not print | The note Git shows for a binary file. No bytes. The decision is made from the finding. |

The right-hand side is a read-only copy of what saw read. It is not the workspace file opened for
editing, so saving it or a formatter cannot change the folder. **Introduced in `<commit>`** opens
that commit as history, parent on the left and the commit on the right, with this file current.
When git cannot read that commit, the control says so and no empty diff opens.

## Files added beside the malware

This is a review of one commit. The multi-file diff is titled with the short hash, the date, and
the subject. Files saw is already removing are marked as such. The files the operator may choose
are the ones that commit added and that have no finding of their own. Files the commit only
changed are named, and are not offered for removal.

In the sidebar those files are grouped by folder. A row says how many other files in the project
mention it, when saw counted that. The operator ticks the ones to take out. The commit diff stays
as it was opened, so the editor does not jump on each tick.

**Take out selected** opens a second multi-file diff of only those files, as deletions from every
commit that still holds them as they were added. **Take them out** confirms that diff. **Keep
them all** leaves the commit's files alone. A commit saw asked about on an earlier run, and then
replaced, is labelled with the ids it has had since.

## A known-malicious package

Each manifest that declares the package opens in one multi-file diff: the manifest as it is,
beside the same manifest with that package removed. Opening the diff writes nothing. The sidebar
shows the package name, the versions saw found, and the declaring files. **Take it out** is the
removal in that diff. **Leave it declared** is the focused action.

## After the last answer

The fix finishes as it does now. The report lists the choices made in this fix, and **Left for
you to decide** still lists anything that was not answered. **Open Changes** is still the diff of
the branch saw prepared.

The preview stays in this view. Agents are told the verdict, not the contents of a file saw is
unsure about, and the editor's chat is not where these questions are asked or answered.
