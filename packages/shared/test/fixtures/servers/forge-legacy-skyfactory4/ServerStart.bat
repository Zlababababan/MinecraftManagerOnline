@echo off

call settings.bat

:start_server
echo Starting Sky Factory 4 Server...
D:\Java\jdk1.8.0_281\bin\java -server -Xms%MIN_RAM% -Xmx%MAX_RAM% %JAVA_PARAMETERS% -jar %SERVER_JAR%
exit /B

goto start_server
