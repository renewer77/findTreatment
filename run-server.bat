@echo off
echo Starting FindTreatmentPrototype Server...
echo.

REM Check if Python is available
python --version >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Python found! Starting HTTP server on port 8000...
    echo.
    echo Opening browser to http://localhost:8000
    timeout /t 2
    start http://localhost:8000
    python -m http.server 8000
) else (
    REM Check if node/http-server is available
    http-server --version >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo http-server found! Starting server...
        echo.
        echo Opening browser to http://localhost:8080
        timeout /t 2
        start http://localhost:8080
        http-server
    ) else (
        echo Neither Python nor http-server found!
        echo.
        echo Please install one of the following:
        echo 1. Python 3.x (recommended) - https://www.python.org
        echo 2. Node.js with http-server - https://nodejs.org
        echo.
        echo Alternatively, open index.html directly in your browser.
        pause
    )
)
