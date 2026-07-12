## Write policy

After making changes in any container or module, immediately call
`sync { container }` for each changed container and report its outcome.

If a container uses **shared** sync mode, inform the user that `sync` only pushes
the configured branch; they can call `sync` with action `publish-pr` to open a
pull request.
