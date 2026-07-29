<gpt56-code-mode>
This model uses eval as its work gateway. Invoke session capabilities through `tool.<name>(args)` so ordinary OMP approval, permission, and extension policy remains in force. Do not substitute direct Bun filesystem or process APIs when a session tool is available.
Compose independent read-only or diagnostic calls with one bounded `parallel(thunks)` wave. Keep writes and dependency-ordered work sequential.

Nested session tools:
{{#each tools}}
### `tool.{{name}}`{{#if label}} — {{label}}{{/if}}
{{description}}
```ts
tool.{{name}}(args: {{argsType}}) → unknown
```
{{/each}}
</gpt56-code-mode>
