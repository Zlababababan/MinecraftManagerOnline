/**
 * Atténuation Log4Shell (CVE-2021-44228) pour MC 1.12 → 1.16.5 (doc 06 §1) : configuration log4j2
 * publiée par Mojang (`log4j2_112-116.xml`, `%msg{nolookups}`), embarquée dans le bundle et écrite
 * dans le dossier du serveur avant chaque lancement. 1.17–1.18.0 : `-Dlog4j2.formatMsgNoLookups=true`.
 * ≥ 1.18.1 : corrigé nativement.
 */
export const LOG4J2_112_116_FILENAME = 'log4j2_112-116.xml';

export const LOG4J2_112_116_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN" packages="com.mojang.util">
    <Appenders>
        <Console name="SysOut" target="SYSTEM_OUT">
            <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg{nolookups}%n" />
        </Console>
        <Queue name="ServerGuiConsole">
            <PatternLayout pattern="[%d{HH:mm:ss} %level]: %msg{nolookups}%n" />
        </Queue>
        <RollingRandomAccessFile name="File" fileName="logs/latest.log" filePattern="logs/%d{yyyy-MM-dd}-%i.log.gz">
            <PatternLayout pattern="[%d{HH:mm:ss}] [%t/%level]: %msg{nolookups}%n" />
            <Policies>
                <TimeBasedTriggeringPolicy />
                <OnStartupTriggeringPolicy />
            </Policies>
        </RollingRandomAccessFile>
    </Appenders>
    <Loggers>
        <Root level="info">
            <filters>
                <MarkerFilter marker="NETWORK_PACKETS" onMatch="DENY" onMismatch="NEUTRAL" />
            </filters>
            <AppenderRef ref="SysOut"/>
            <AppenderRef ref="File"/>
            <AppenderRef ref="ServerGuiConsole"/>
        </Root>
    </Loggers>
</Configuration>
`;
