@REM ce.bat — Windows shim: sets CODEEXAM_INVOKED_AS=ce, then runs node src\index.js
@REM Copyright (c) 2026 Andrew Schulman
@REM https://github.com/aschulman42-cell/code-exam
@REM Co-authored with Claude (Claude Code).
@REM Licensed under the Apache License, Version 2.0; see LICENSE.
@echo off
setlocal
set "CODEEXAM_INVOKED_AS=ce"
node "%~dp0src\index.js" %*
