# Feature map: fixture A

| Feature | Drive | Args |
|---|---|---|
| [Settings: appearance](settings.md) | `settings.toggle-dark` | `user` |
| [Projects: two-step create form](projects.md) | `projects.create` | `user`, `slug` |
| [Invites: admin generates, newcomer joins](invites.md) | `invites.generate-and-join` | `admin` |

Each file holds one fenced `drive` block in the Kitchen drive format. Kitchen
(`src/proof/drive.ts`) interprets it; `bin/dev` only answers primitive calls.
`bin/dev describe` lists these files; Kitchen parses the drives in them.
