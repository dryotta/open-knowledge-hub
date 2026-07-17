---
title: Help and common guidance
args:
  question: The user's question or common-guidance topic. Use "ingest" for source-document ingestion and "grilling" for one-decision plan stress-testing.
---
Search the canonical Open Knowledge Hub documentation and common instructions, then
return the most relevant documents as bounded protocol-native embedded resources,
resource links, and discipline for answering from those sources. Oversized selected
content is explicitly deferred to `read_resource`. This tool is mandatory before
source-document ingestion (`question: "ingest"`) and before grilling or stress-testing
a plan one decision at a time (`question: "grilling"`). Omit `question` to start from
both indexes.
