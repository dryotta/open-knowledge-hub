---
type: Concept
title: Auth
description: How authentication works in this system
---

# Auth

Authentication uses signed session tokens issued at login and verified on each
request. Tokens expire after 24 hours; refresh tokens rotate on use.

# Citations

[1] internal design note — auth flow