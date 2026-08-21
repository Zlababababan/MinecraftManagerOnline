@echo off
set FORGE_VERSION=43.2.8
:: To use a specific Java runtime, set an environment variable named ATM8_JAVA to the full path of java.exe.
:: To disable automatic restarts, set an environment variable named ATM8_RESTART to false.
:: To install the pack without starting the server, set an environment variable named ATM8_INSTALL_ONLY to true.

set INSTALLER="%~dp0forge-1.19.2-%FORGE_VERSION%-installer.jar"
set FORGE_URL="http://files.minecraftforge.net/maven/net/minecraftforge/forge/1.19.2-%FORGE_VERSION%/forge-1.19.2-%FORGE_VERSION%-installer.jar"

:JAVA
if not defined ATM8_JAVA (
    set ATM8_JAVA=java
)

"%ATM8_JAVA%" -version 1>nul 2>nul || (
   echo Minecraft 1.19 requires Java 17 - Java not found
   pause
   exit /b 1
)

:FORGE
setlocal
cd /D "%~dp0"
if not exist "libraries" (
    echo Forge not installed, installing now.
    if not exist %INSTALLER% (
        echo No Forge installer found, downloading from %FORGE_URL%
        bitsadmin.exe /rawreturn /nowrap /transfer forgeinstaller /download /priority FOREGROUND %FORGE_URL% %INSTALLER%
    )
    
    echo Running Forge installer.
    "%ATM8_JAVA%" -jar %INSTALLER% -installServer
)

if not exist "server.properties" (
    (
        echo allow-flight=true
        echo motd=All the Mods 8
        echo max-tick-time=180000
    )> "server.properties"
)

if "%ATM8_INSTALL_ONLY%" == "true" (
    echo INSTALL_ONLY: complete
    goto:EOF
)

for /f tokens^=2-5^ delims^=.-_^" %%j in ('"%ATM8_JAVA%" -fullversion 2^>^&1') do set "jver=%%j"
if not %jver% geq 17  (
    echo Minecraft 1.19 requires Java 17 - found Java %jver%
    pause
    exit /b 1
) 

:START
"%ATM8_JAVA%" @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.19.2-%FORGE_VERSION%/win_args.txt nogui

if "%ATM8_RESTART%" == "false" ( 
    goto:EOF 
)

echo Restarting automatically in 10 seconds (press Ctrl + C to cancel)
timeout /t 10 /nobreak > NUL
goto:START
