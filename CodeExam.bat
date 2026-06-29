@echo off
setlocal
set "CODEEXAM_INVOKED_AS=CodeExam"
node "%~dp0src\index.js" %*
