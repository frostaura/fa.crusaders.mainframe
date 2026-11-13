FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /workspace/src/backend
COPY src/backend/ /workspace/src/backend/
RUN dotnet restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj
RUN dotnet publish Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/publish .
# Not root. The runtime image ships `app` as uid 1654 ($APP_UID); the compose files' volume-init
# service chowns the two volumes to that number, so a base image that moved it must fail HERE
# rather than as a photo upload refused at the club. A USB biometric reader needs its device
# node's group added in compose (group_add) once the API is not root.
RUN test "$(id -u app)" = 1654 \
    && mkdir -p /app/media /app/biometric/templates \
    && chown -R app:app /app/media /app/biometric
USER app
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
# The commit this image was built from. CI passes it; a local build says "unknown". It is the
# answer to "what does the club run": `docker inspect` shows the label and the environment.
ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision=$BUILD_SHA
ENV BUILD_SHA=$BUILD_SHA
# tini as PID 1: dotnet as init cannot die of its own SIGABRT, so a start-up failure (a refused
# migration, a missing secret) spun at full CPU with the container still "running" and the restart
# policy never firing. Under tini the same failure exits 134. See DeploymentPostureTests.
ENTRYPOINT ["/usr/bin/tini", "--", "dotnet", "Crusaders.Mainframe.Api.dll"]
