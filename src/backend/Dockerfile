FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /workspace/src/backend
COPY src/backend/ /workspace/src/backend/
RUN dotnet restore Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj
RUN dotnet publish Crusaders.Mainframe.Api/Crusaders.Mainframe.Api.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/publish .
# Court-box firmware the API offers over the air, served at /firmware/. In CI the
# iot-sign job fills firmware-payload/ (signed .bin + manifest, or an UNSIGNED
# README) before this image is built; locally the directory holds only its
# placeholder README, so the COPY always has a source and the build never
# depends on an artifact being present. See firmware-payload/README.txt.
COPY firmware-payload/ /app/firmware/
EXPOSE 5000
ENV ASPNETCORE_URLS=http://+:5000
ENTRYPOINT ["dotnet", "Crusaders.Mainframe.Api.dll"]
