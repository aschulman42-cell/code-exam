@REM CodeExam.bat — Windows counterpart to `CodeExam`; sets CODEEXAM_INVOKED_AS=CodeExam, runs src\index.js
@REM Copyright (c) 2026 Andrew Schulman
@REM https://github.com/aschulman42-cell/code-exam
@REM Co-authored with Claude (Claude Code).
@REM Licensed under the Apache License, Version 2.0; see LICENSE.
@echo off
setlocal
set "CODEEXAM_INVOKED_AS=CodeExam"
node "%~dp0src\index.js" %*
