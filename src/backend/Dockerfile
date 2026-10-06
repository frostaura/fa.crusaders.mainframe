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
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
# tini as PID 1: dotnet as init cannot die of its own SIGABRT, so a start-up failure (a refused
# migration, a missing secret) spun at full CPU with the container still "running" and the restart
# policy never firing. Under tini the same failure exits 134. See DeploymentPostureTests.
ENTRYPOINT ["/usr/bin/tini", "--", "dotnet", "Crusaders.Mainframe.Api.dll"]
