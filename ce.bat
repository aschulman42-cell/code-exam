@echo off
setlocal
set "CODEEXAM_INVOKED_AS=ce"
node "%~dp0src\index.js" %*
