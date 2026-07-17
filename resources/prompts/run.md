# Skill
{{var:skill/name}} — {{var:skill/description}}

{{var:target}}# Input
{{var:input}}

# Required MCP resources
{{var:resources}}

<discipline name="{{var:skill/name}}">

Apply every embedded resource in this tool result. Before carrying out the skill,
fetch each required resource marked as deferred with `read_resource`; never open an
`okh://` URI with filesystem or web tools. Other linked resources are bundled
references that can be fetched on demand.

{{var:skill/body}}

</discipline>

{{prompt:partials/write-policy.md}}
