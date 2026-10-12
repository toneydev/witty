@echo off
rem witty portable launcher: runs dist\cli.js next to this file with the Node on PATH.
rem node.exe is looked up in the PATH directories only: a bare `node` (or `where node`)
rem lets cmd.exe run a node.exe, node.cmd or node.bat planted in the current directory.
setlocal EnableExtensions DisableDelayedExpansion
set "WITTY_NODE="
for %%I in (node.exe) do set "WITTY_NODE=%%~$PATH:I"
if not defined WITTY_NODE (
  echo witty: Node.js 22.18 or later is needed on PATH ^(winget install OpenJS.NodeJS.LTS^) 1>&2
  exit /b 127
)
rem The line expands before endlocal runs, so node starts with the caller's environment.
endlocal & "%WITTY_NODE%" "%~dp0dist\cli.js" %*
