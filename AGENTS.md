# Project Agent Instructions

When spawning a `task` subagent, omit optional fields that have no value. In particular, supply `sourceSession` only for `seance`; never include it for `scout`, even as an empty string. On a tool validation error, change the arguments before retrying.
