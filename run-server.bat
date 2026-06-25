@echo off
echo Starting FindTreatmentPrototype Server...
echo.

REM Check if Node.js is available
node --version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Node.js found! Starting local server on port 8000...
    echo.
    echo Opening browser to http://localhost:8000
    timeout /t 2
    start http://localhost:8000
    node server.js
) else (
    REM Check if Python is available for static-only fallback
    python --version >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo Python found! Starting static HTTP server on port 8000...
        echo.
        echo Opening browser to http://localhost:8000
        timeout /t 2
        start http://localhost:8000
        python -m http.server 8000
    ) else (
        echo Neither Node.js nor Python found!
        echo.
        echo Please install one of the following:
        echo 1. Node.js 18+ (required for Bedrock submit) - https://nodejs.org
        echo 2. Python 3.x for static-only viewing - https://www.python.org
        echo.
        echo Alternatively, open index.html directly in your browser.
        pause
    )
)
