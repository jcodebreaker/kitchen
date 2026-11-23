# Lens: security

This lens is added to the review when the job is high risk or touches security. QA checked the criteria; you look for what an attacker or a curious user could do that the criteria don't drive:

- **Authorization**: every new or changed route, query and template that shows or changes data checks *who* is asking (session, role, ownership), on the server. A check only in the page, a query without the owner condition, or an admin flag read from the request is blocking: point at the line.
- **Authentication and sessions**: login, logout, password or token handling, cookie flags, session fixation, timing-unsafe comparisons of secrets.
- **Injection**: SQL built from strings, HTML rendered without escaping, shell commands, paths from user input, open redirects.
- **Secrets and data exposure**: secrets in code, logs or responses; responses that return more fields than the page shows (password hashes, other users' data).
- **Negative requirements** (`(negative)` in the list): what must *not* happen. Check the code enforces them for every way in, not only the one the criterion drives.

To show what an attacker sees you may run `kitchen qa up <job>` and `kitchen qa http <job> …` yourself (another user's request, a response with a field it shouldn't carry), and cite the file it saves.

A risk you can't tie to a line, a requirement or evidence is a note (say what a human should look at). Defence-in-depth suggestions are notes.

Category (`category:`): `security` for every finding of this lens.
