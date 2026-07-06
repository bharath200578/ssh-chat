@echo off
echo ==========================================
echo   Installing Call of SSH Dependencies
echo ==========================================
echo.
echo [1/3] Installing root dependencies (cross-env)...
call npm install
if %ERRORLEVEL% neq 0 (
    echo Error installing root dependencies.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Installing daemon dependencies (ws)...
cd daemon
call npm install
if %ERRORLEVEL% neq 0 (
    echo Error installing daemon dependencies.
    cd ..
    pause
    exit /b %ERRORLEVEL%
)
cd ..

echo.
echo [3/3] Installing frontend dependencies (React, Vite, Lucide)...
cd frontend
call npm install
if %ERRORLEVEL% neq 0 (
    echo Error installing frontend dependencies.
    cd ..
    pause
    exit /b %ERRORLEVEL%
)
cd ..

echo.
echo ==========================================
echo   Installation Successful!
echo ==========================================
echo.
pause
