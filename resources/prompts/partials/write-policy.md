## Write policy

After editing files:
1. Summarise the diff for the user and get explicit confirmation before persisting.
2. Call the `sync` tool ({ container }). It commits + pushes directly (sync: auto)
   or opens a pull request (sync: pr), per the container's configuration.
Never persist changes without the user's go-ahead. If several candidate
containers/modules are listed below, choose or confirm ONE target before writing.
