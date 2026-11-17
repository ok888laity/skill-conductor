@echo off
setlocal
rem Windows launcher. Uses SKILL_CONDUCTOR_NODE, PATH, or the project-local
rem .skill-conductor/runtime Node installed by install.ps1. No global edits.
if defined SKILL_CONDUCTOR_NODE goto usenode
for /d %%D in ("%~dp0..\runtime\node-v*") do if exist "%%~fD\node.exe" set "NODE=%%~fD\node.exe"
if defined NODE goto run
where node >nul 2>nul
if errorlevel 1 goto nonode
set "NODE=node"
goto run

:usenode
set "NODE=%SKILL_CONDUCTOR_NODE%"
goto run

:run
"%NODE%" "%~dp0bin\skill-conductor.mjs" %*
exit /b %errorlevel%

:nonode
echo Node.js 20.11+ not found. Run install.ps1 or set SKILL_CONDUCTOR_NODE to node.exe. 1>&2
exit /b 1
