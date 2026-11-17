@echo off
setlocal
rem Windows launcher. Set SKILL_CONDUCTOR_NODE to an explicit node.exe if needed.
if defined SKILL_CONDUCTOR_NODE goto usenode
goto findnode

:usenode
set "NODE=%SKILL_CONDUCTOR_NODE%"
goto run

:findnode
where node >nul 2>nul
if errorlevel 1 goto fallback
set "NODE=node"
goto run

:fallback
set "FALLBACK=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%FALLBACK%" goto nonode
set "NODE=%FALLBACK%"
goto run

:run
"%NODE%" "%~dp0bin\skill-conductor.mjs" %*
exit /b %errorlevel%

:nonode
echo Node.js 20.11+ not found. Set SKILL_CONDUCTOR_NODE to node.exe. 1>&2
exit /b 1
