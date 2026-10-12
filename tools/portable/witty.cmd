@echo off
rem witty portable launcher: runs dist\cli.js next to this file with the Node on PATH.
where node >nul 2>nul
if errorlevel 1 (
  echo witty: Node.js 22.18 or later is needed on PATH ^(winget install OpenJS.NodeJS.LTS^) 1>&2
  exit /b 127
)
node "%~dp0dist\cli.js" %*
