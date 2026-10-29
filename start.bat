@echo off
rem Start the week planner (Windows). Extra arguments are passed through, e.g. start.bat --port 9000
cd /d "%~dp0"

set "PYCMD="
py -3 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3"
if defined PYCMD goto :run

python -c "import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)" >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
if defined PYCMD goto :run

echo.
echo Python 3 was not found. Install Python 3.8 or newer from https://www.python.org/downloads/
echo Tick "Add python.exe to PATH" in the installer, then run this file again.
goto :fail

:run
%PYCMD% server.py %*
if errorlevel 1 goto :fail
goto :end

:fail
echo.
echo The planner stopped with an error. See the message above.
pause
exit /b 1

:end
