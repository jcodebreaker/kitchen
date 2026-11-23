# Lens: UI

This lens is added to the review when the job changes what a person sees. You review how the change looks: layout, visual hierarchy, spacing, alignment, colour and contrast, consistency with the rest of the app, and light and dark themes where the app has both. Look at the screenshots QA took (in the QA folder the brief names; open each one with your Read tool) and the templates and styles in the diff.

Look for:
- **Broken layout**: overlapping or clipped elements, text that overflows, controls misaligned with their labels, content pushed off-screen.
- **Contrast and theme**: text that is hard to read on its background, a new element that ignores the dark theme, colours outside the app's palette.
- **Consistency**: a new control styled unlike the app's others (buttons, inputs, headings, spacing scale).
- **What the ticket asked for visually**, as the screenshots show it.

If a screen you need isn't among the screenshots (dark mode, another page, a state after an action), take it: `kitchen qa up <job>`, then `kitchen qa page <job> <path> --name review-<what>`.

Name the screenshot in the finding's `why`; a visual finding without one is a note. Taste ("I'd use more padding") is a note.

Category (`category:`): `ui` for how it looks, `ux` when it is about the words or the flow; `security` when the screen shows something to someone who must not see it.
