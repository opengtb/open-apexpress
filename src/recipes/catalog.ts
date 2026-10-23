import {
  bool,
  container,
  hostPortParam,
  imageParam,
  mosquittoAuth,
  mosquittoUrl,
  nameParam,
  num,
  quote,
  shellQuote,
  str,
  t,
  timezoneParam,
  writeFile,
  writeFileOnce,
} from "./helpers";
import type { BuildResult, Pack, Param, Recipe } from "./types";
// The MCP server source is embedded in the app and written into the container at each start.
// @ts-expect-error: a JS module for TypeScript, plain text for Bun.
import MCP_SERVER from "./assets/eclypse-mcp.mjs" with { type: "text" };

/**
 * The server goes into the container command, and Linux caps one argument at 128 KB: it is sent gzipped
 * and base64-encoded (about a third of its size). A Windows checkout may give CRLF line endings: LF only.
 */
export const MCP_SERVER_PACKED = Buffer.from(Bun.gzipSync(new TextEncoder().encode(MCP_SERVER.replace(/\r\n/g, "\n")), { level: 9 })).toString("base64");

const empty = (): BuildResult => ({ containers: [], links: [], credentials: [], notes: [] });

const passwordParam = (id: string, label = t("Mot de passe", "Password"), advanced = false): Param => ({
  id,
  label,
  help: t("Laissez vide pour en générer un automatiquement.", "Leave empty to generate one automatically."),
  type: "password",
  generate: "password",
  advanced,
});

/** bcrypt hash in the $2a$ flavour expected by Node-RED and FileBrowser. */
const bcrypt = (password: string): string =>
  Bun.password.hashSync(password, { algorithm: "bcrypt", cost: 8 }).replace(/^\$2b\$/, "$2a$");

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const mosquitto: Recipe = {
  id: "mosquitto",
  name: "Mosquitto",
  category: "messaging",
  badge: "MQ",
  color: "#660066",
  status: "validated",
  summary: t("Broker MQTT, le hall de gare de toutes les données.", "MQTT broker, the hub for all your data."),
  description: t(
    "Le broker MQTT où se croisent Zigbee2MQTT, ChirpStack, Node-RED et Telegraf. À installer en premier.",
    "The MQTT broker shared by Zigbee2MQTT, ChirpStack, Node-RED and Telegraf. Install it first.",
  ),
  ramMb: 10,
  homepage: "https://mosquitto.org",
  params: [
    hostPortParam(50083),
    {
      id: "auth",
      label: t("Authentification", "Authentication"),
      help: t(
        "Recommandé sur site. Les autres services installés ici utiliseront automatiquement ces identifiants.",
        "Recommended on site. Services installed here will use these credentials automatically.",
      ),
      type: "boolean",
      default: false,
    },
    { id: "user", label: t("Utilisateur", "User"), type: "text", default: "apex" },
    passwordParam("password"),
    {
      id: "websockets",
      label: t("MQTT sur WebSocket", "MQTT over WebSocket"),
      help: t(
        "Second accès pour les clients web, comme le client MQTT Web d'Open Apexpress.",
        "Second listener for web clients, such as the Open Apexpress MQTT Web client.",
      ),
      type: "boolean",
      default: true,
    },
    { id: "wsPort", label: t("Port WebSocket", "WebSocket port"), type: "number", default: 50085, advanced: true },
    {
      id: "persistence",
      label: t("Persistance des messages", "Message persistence"),
      help: t("Conserve les messages retenus après un redémarrage.", "Keeps retained messages across restarts."),
      type: "boolean",
      default: true,
      advanced: true,
    },
    imageParam("eclipse-mosquitto:2"),
    nameParam("mosquitto"),
  ],
  build({ apexIp, values: v }) {
    const auth = bool(v.auth);
    const persistence = bool(v.persistence);
    const websockets = bool(v.websockets);
    const conf = [
      "listener 1883",
      ...(websockets ? ["listener 9001", "protocol websockets"] : []),
      `allow_anonymous ${auth ? "false" : "true"}`,
      ...(auth ? ["password_file /mosquitto/config/passwd"] : []),
      ...(persistence ? ["persistence true", "persistence_location /mosquitto/data/"] : ["persistence false"]),
      "connection_messages true",
      "log_dest stdout",
    ].join("\n");
    const steps = [writeFile("/mosquitto/config/mosquitto.conf", conf)];
    if (auth) {
      steps.push(
        `mosquitto_passwd -b -c /mosquitto/config/passwd ${shellQuote(str(v.user))} ${shellQuote(str(v.password))}`,
        "chown mosquitto:mosquitto /mosquitto/config/passwd",
        "chmod 0700 /mosquitto/config/passwd",
      );
    }
    steps.push("exec mosquitto -c /mosquitto/config/mosquitto.conf");
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        cmd: ["sh", "-c", steps.join(" && ")],
        ports: [
          { container: "1883/tcp", host: num(v.hostPort) },
          ...(websockets ? [{ container: "9001/tcp", host: num(v.wsPort) }] : []),
        ],
        volumes: persistence ? [{ volume: "mosquitto-data", target: "/mosquitto/data" }] : [],
      }),
    });
    r.links.push({ label: t("Broker MQTT", "MQTT broker"), url: `mqtt://${apexIp}:${v.hostPort}` });
    if (websockets) r.links.push({ label: t("MQTT sur WebSocket", "MQTT over WebSocket"), url: `ws://${apexIp}:${v.wsPort}` });
    if (auth) {
      r.credentials.push({ label: t("MQTT : utilisateur", "MQTT: user"), value: str(v.user) });
      r.credentials.push({ label: t("MQTT : mot de passe", "MQTT: password"), value: str(v.password) });
    } else {
      r.notes.push(
        t(
          "Broker en accès anonyme : parfait sur un banc de test, à protéger sur un site.",
          "Anonymous broker: fine on a test bench, protect it on a real site.",
        ),
      );
    }
    return r;
  },
};

const mqttWeb: Recipe = {
  id: "mqttweb",
  name: "MQTT Web",
  category: "messaging",
  badge: "MX",
  color: "#00b173",
  status: "experimental",
  summary: t("Client MQTT dans le navigateur, pour voir passer les messages.", "MQTT client in the browser, to watch messages go by."),
  description: t(
    "MQTTX Web : abonnez-vous à zigbee2mqtt/#, application/# ou # et voyez les messages arriver en direct, publiez pour tester. Pratique pour déboguer Zigbee2MQTT, ChirpStack ou Node-RED sans installer MQTT Explorer.",
    "MQTTX Web: subscribe to zigbee2mqtt/#, application/# or # and watch messages live, publish to test. Handy to debug Zigbee2MQTT, ChirpStack or Node-RED without installing MQTT Explorer.",
  ),
  ramMb: 40,
  requires: ["mosquitto"],
  homepage: "https://mqttx.app/web",
  troubleshooting: [
    t(
      "« Connection failed » : le client se connecte depuis votre navigateur, pas depuis l'APEX. Il faut l'accès WebSocket de Mosquitto (option « MQTT sur WebSocket », réinstallez Mosquitto avec « Le remplacer » s'il date d'avant).",
      "\"Connection failed\": the client connects from your browser, not from the APEX. It needs Mosquitto's WebSocket listener (\"MQTT over WebSocket\" option; reinstall Mosquitto with \"Replace\" if it predates it).",
    ),
    t(
      "Paramètres de connexion : protocole ws://, hôte = IP de l'APEX, port WebSocket de Mosquitto (50085 par défaut), chemin /mqtt.",
      "Connection settings: ws:// protocol, host = APEX IP, Mosquitto WebSocket port (50085 by default), path /mqtt.",
    ),
    t(
      "Les connexions sont enregistrées dans votre navigateur, pas sur l'APEX : à recréer sur un autre PC.",
      "Connections are saved in your browser, not on the APEX: create them again on another PC.",
    ),
  ],
  params: [hostPortParam(50087), imageParam("emqx/mqttx-web:v1.13.1"), nameParam("mqttweb")],
  build({ apexIp, values: v, all }) {
    const m = all.mosquitto;
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({ image: str(v.image), ports: [{ container: "80/tcp", host: num(v.hostPort) }] }),
    });
    r.links.push({ label: t("Client MQTT Web", "MQTT Web client"), url: `http://${apexIp}:${v.hostPort}` });
    if (m && bool(m.websockets)) {
      r.notes.push(
        t(
          `Nouvelle connexion : hôte ws:// ${apexIp}, port ${m.wsPort} (pas ${m.hostPort}), chemin /mqtt. Un navigateur ne parle pas mqtt:// directement, seulement WebSocket (ws://).`,
          `New connection: host ws:// ${apexIp}, port ${m.wsPort} (not ${m.hostPort}), path /mqtt. A browser cannot speak mqtt:// directly, only WebSocket (ws://).`,
        ),
      );
      const auth = mosquittoAuth(all);
      if (auth) r.notes.push(t("Identifiants : ceux de Mosquitto, ci-dessus.", "Credentials: the Mosquitto ones, above."));
    } else {
      r.notes.push(
        t(
          "L'option « MQTT sur WebSocket » de Mosquitto est désactivée : le client ne pourra pas se connecter.",
          "Mosquitto's \"MQTT over WebSocket\" option is off: the client will not be able to connect.",
        ),
      );
    }
    return r;
  },
};

// ---------------------------------------------------------------------------
// IoT
// ---------------------------------------------------------------------------

const zigbee2mqtt: Recipe = {
  id: "zigbee2mqtt",
  name: "Zigbee2MQTT",
  category: "iot",
  badge: "ZB",
  color: "#f2b31b",
  status: "validated",
  summary: t("Passerelle Zigbee vers MQTT, coordinateur en Ethernet.", "Zigbee to MQTT bridge with an Ethernet coordinator."),
  description: t(
    "Pilote vos modules Zigbee (SONOFF, Aqara, IKEA…) depuis l'automate. Coordinateur réseau type SMLIGHT SLZB-06 : pas de clé USB sur l'APEX.",
    "Drive Zigbee devices (SONOFF, Aqara, IKEA…) from the controller. Uses a network coordinator such as the SMLIGHT SLZB-06: no USB on the APEX.",
  ),
  ramMb: 200,
  requires: ["mosquitto"],
  homepage: "https://www.zigbee2mqtt.io",
  troubleshooting: [
    t(
      "Conteneur « Running » mais pas d'interface : Zigbee2MQTT n'ouvre son interface qu'une fois connecté au coordinateur. Vérifiez qu'il est alimenté, branché au réseau, et utilisez « Tester le coordinateur ».",
      "Container \"Running\" but no web UI: Zigbee2MQTT only opens its UI once connected to the coordinator. Check that it is powered and on the network, then use \"Test the coordinator\".",
    ),
    t(
      "Journal : installez FileBrowser sur le volume z2m-data et ouvrez z2m-console.log. Bloqué sur « ASH Adapter reset » = le coordinateur ne répond pas (mauvaise IP, éteint, ou déjà utilisé par un autre système).",
      "Log: install FileBrowser on the z2m-data volume and open z2m-console.log. Stuck on \"ASH Adapter reset\" = the coordinator does not answer (wrong IP, powered off, or already used by another system).",
    ),
    t(
      "Un coordinateur ne doit servir qu'à un seul système : le SLZB accepte une deuxième connexion mais les deux se perturbent. Déconnectez tout Home Assistant ou autre Zigbee2MQTT qui l'utilise encore.",
      "A coordinator must serve a single system: the SLZB accepts a second connection but both disturb each other. Disconnect any Home Assistant or other Zigbee2MQTT still using it.",
    ),
    t(
      "Sur le SLZB : mode « Coordinateur Zigbee », connexion Ethernet, port 6638. Type : ember pour les puces Silicon Labs (SLZB-06M, -06MG24…), zstack pour les puces Texas Instruments (SLZB-06, -06P7).",
      "On the SLZB: \"Zigbee coordinator\" mode, Ethernet connection, port 6638. Type: ember for Silicon Labs chips (SLZB-06M, -06MG24…), zstack for Texas Instruments chips (SLZB-06, -06P7).",
    ),
    t(
      "Fixez l'IP du coordinateur (IP statique ou réservation DHCP) : s'il en change, Zigbee2MQTT le perd.",
      "Give the coordinator a fixed IP (static or DHCP reservation): if it changes, Zigbee2MQTT loses it.",
    ),
    t(
      "Mauvaise IP ou mauvais type : réinstallez Zigbee2MQTT en choisissant « Le remplacer ». L'IP, le port, le type et le broker sont mis à jour, la clé réseau et les appareils sont conservés.",
      "Wrong IP or type: reinstall Zigbee2MQTT with \"Replace\". IP, port, type and broker are updated, the network key and the devices are kept.",
    ),
    t(
      "Repartir de zéro : supprimez le volume z2m-data puis réinstallez. Un nouveau réseau Zigbee est créé, tous les appareils sont à réappairer.",
      "Start over: delete the z2m-data volume, then reinstall. A new Zigbee network is created, every device must be paired again.",
    ),
  ],
  params: [
    {
      id: "coordinatorHost",
      label: t("IP du coordinateur Zigbee", "Zigbee coordinator IP"),
      help: t("Adresse fixe du coordinateur Ethernet (ex. SLZB-06).", "Fixed address of the Ethernet coordinator (e.g. SLZB-06)."),
      type: "text",
      required: true,
      placeholder: "192.168.1.11",
    },
    { id: "coordinatorPort", label: t("Port du coordinateur", "Coordinator port"), type: "number", default: 6638 },
    {
      id: "adapter",
      label: t("Type de coordinateur", "Coordinator type"),
      type: "select",
      default: "ember",
      options: [
        { value: "ember", label: t("ember (Silicon Labs, SLZB-06M/MG)", "ember (Silicon Labs, SLZB-06M/MG)") },
        { value: "zstack", label: t("zstack (Texas Instruments, SLZB-06)", "zstack (Texas Instruments, SLZB-06)") },
        { value: "deconz", label: t("deconz (ConBee, RaspBee)", "deconz (ConBee, RaspBee)") },
        { value: "zigate", label: t("zigate", "zigate") },
      ],
    },
    hostPortParam(50084, t("Port de l'interface web", "Web UI port")),
    {
      id: "frontendToken",
      label: t("Mot de passe de l'interface web", "Web UI password"),
      help: t("Laissez vide pour une interface sans mot de passe.", "Leave empty for an interface without password."),
      type: "password",
      advanced: true,
    },
    imageParam("koenkk/zigbee2mqtt:2.14.1"),
    nameParam("zigbee2mqtt"),
  ],
  build({ apexIp, values: v, all }) {
    const auth = mosquittoAuth(all);
    const yaml = [
      "mqtt:",
      "  base_topic: zigbee2mqtt",
      `  server: ${mosquittoUrl(apexIp, all)}`,
      ...(auth ? [`  user: ${quote(auth.user)}`, `  password: ${quote(auth.password)}`] : []),
      "serial:",
      `  port: tcp://${v.coordinatorHost}:${v.coordinatorPort}`,
      `  adapter: ${v.adapter}`,
      "frontend:",
      "  enabled: true",
      "  port: 8080",
      ...(str(v.frontendToken) ? [`  auth_token: ${quote(v.frontendToken)}`] : []),
      "availability:",
      "  enabled: true",
      "advanced:",
      "  network_key: GENERATE",
      "  pan_id: GENERATE",
      "  ext_pan_id: GENERATE",
    ].join("\n");
    // The file is only written once (it keeps the network key and user edits), but the
    // coordinator and broker addresses are refreshed on every start so a reinstall fixes them.
    const refresh = [
      `s#^  port: tcp://.*#  port: tcp://${v.coordinatorHost}:${v.coordinatorPort}#`,
      `s#^  adapter: .*#  adapter: ${v.adapter}#`,
      `s#^  server: mqtt.*#  server: ${mosquittoUrl(apexIp, all)}#`,
    ]
      .map((e) => `-e ${shellQuote(e)}`)
      .join(" ");
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        entrypoint: ["sh", "-c"],
        cmd: [
          `${writeFileOnce("/app/data/configuration.yaml", yaml)} && sed -i ${refresh} /app/data/configuration.yaml && chmod a+rw /app/data/configuration.yaml && cd /app && exec node index.js > /app/data/z2m-console.log 2>&1`,
        ],
        ports: [{ container: "8080/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: "z2m-data", target: "/app/data" }],
      }),
    });
    r.links.push({ label: t("Interface Zigbee2MQTT", "Zigbee2MQTT UI"), url: `http://${apexIp}:${v.hostPort}` });
    r.notes.push(
      t(
        "Ne supprimez jamais le volume z2m-data : il contient la clé du réseau Zigbee et tous les appareils appairés.",
        "Never delete the z2m-data volume: it holds the Zigbee network key and every paired device.",
      ),
      t(
        "configuration.yaml n'est écrit qu'au premier démarrage (clé réseau, appareils). L'IP du coordinateur, son type et le broker sont remis à jour à chaque réinstallation. Le reste se modifie avec FileBrowser sur le volume z2m-data.",
        "configuration.yaml is written on first start only (network key, devices). Coordinator IP, type and broker are refreshed on every reinstall. Edit the rest with FileBrowser on the z2m-data volume.",
      ),
    );
    return r;
  },
};

const LORA_REGIONS = ["eu868", "eu433", "in865", "ru864"] as const;

const chirpstack: Recipe = {
  id: "chirpstack",
  name: "ChirpStack",
  category: "iot",
  badge: "CS",
  color: "#2d8cf0",
  status: "validated",
  summary: t("Serveur LoRaWAN complet, sans cloud ni abonnement.", "Complete LoRaWAN network server, no cloud, no subscription."),
  description: t(
    "ChirpStack v4 avec PostgreSQL, Redis, Gateway Bridge (Semtech UDP) et API REST. Les fichiers de configuration sont écrits dans des volumes par un conteneur d'initialisation : plus besoin de builder des images custom.",
    "ChirpStack v4 with PostgreSQL, Redis, Gateway Bridge (Semtech UDP) and REST API. Configuration files are written to volumes by an init container: no custom images to build anymore.",
  ),
  ramMb: 220,
  requires: ["mosquitto"],
  homepage: "https://www.chirpstack.io",
  params: [
    {
      id: "region",
      label: t("Région LoRaWAN", "LoRaWAN region"),
      type: "select",
      default: "eu868",
      options: LORA_REGIONS.map((r) => ({ value: r, label: t(r.toUpperCase(), r.toUpperCase()) })),
    },
    hostPortParam(50081, t("Port de l'interface web", "Web UI port")),
    { id: "udpPort", label: t("Port UDP des gateways", "Gateway UDP port"), type: "number", default: 50170 },
    { id: "restApi", label: t("API REST + Swagger", "REST API + Swagger"), type: "boolean", default: true },
    { id: "restPort", label: t("Port de l'API REST", "REST API port"), type: "number", default: 50090, advanced: true },
    passwordParam("dbPassword", t("Mot de passe PostgreSQL", "PostgreSQL password"), true),
    {
      id: "apiSecret",
      label: t("Secret de l'API ChirpStack", "ChirpStack API secret"),
      type: "password",
      generate: "token",
      advanced: true,
    },
    { id: "pgPort", label: t("Port PostgreSQL", "PostgreSQL port"), type: "number", default: 50432, advanced: true },
    { id: "redisPort", label: t("Port Redis", "Redis port"), type: "number", default: 50379, advanced: true },
    { id: "netId", label: t("NetID", "NetID"), type: "text", default: "000000", advanced: true },
    { id: "image", label: t("Image ChirpStack", "ChirpStack image"), type: "text", default: "chirpstack/chirpstack:4.12.1", advanced: true },
    { id: "bridgeImage", label: t("Image Gateway Bridge", "Gateway Bridge image"), type: "text", default: "chirpstack/chirpstack-gateway-bridge:4", advanced: true },
    { id: "restImage", label: t("Image API REST", "REST API image"), type: "text", default: "chirpstack/chirpstack-rest-api:4", advanced: true },
    { id: "postgresImage", label: t("Image PostgreSQL", "PostgreSQL image"), type: "text", default: "postgres:14-alpine", advanced: true },
    { id: "redisImage", label: t("Image Redis", "Redis image"), type: "text", default: "redis:7-alpine", advanced: true },
    { id: "initImage", label: t("Image d'initialisation", "Init image"), type: "text", default: "alpine:3.20", advanced: true },
  ],
  build({ apexIp, values: v, all }) {
    const region = str(v.region);
    const auth = mosquittoAuth(all);
    const mqtt = mosquittoUrl(apexIp, all, "tcp");
    const mqttAuth = auth ? [`username=${quote(auth.user)}`, `password=${quote(auth.password)}`] : [];
    const dsn = `postgres://chirpstack:${encodeURIComponent(str(v.dbPassword))}@${apexIp}:${v.pgPort}/chirpstack?sslmode=disable`;

    // TOML sections are separated by blank lines and the file ends with one: the parser is picky.
    const chirpstackToml = [
      `[logging]\nlevel="info"`,
      `[postgresql]\ndsn=${quote(dsn)}\nmax_open_connections=10\nmin_idle_connections=0`,
      `[redis]\nservers=[${quote(`redis://${apexIp}:${v.redisPort}`)}]`,
      `[network]\nnet_id=${quote(v.netId)}\nenabled_regions=[${quote(region)}]`,
      `[api]\nbind="0.0.0.0:8080"\nsecret=${quote(v.apiSecret)}`,
      `[integration]\nenabled=["mqtt"]`,
      [`[integration.mqtt]`, `server=${quote(`${mqtt}/`)}`, "json=true", ...mqttAuth].join("\n"),
    ].join("\n\n");
    const regionToml = [
      `[[regions]]\nid=${quote(region)}\ndescription=${quote(region.toUpperCase())}\ncommon_name=${quote(region.toUpperCase())}`,
      `[regions.gateway.backend]\nenabled="mqtt"`,
      [`[regions.gateway.backend.mqtt]`, `topic_prefix=${quote(region)}`, `server=${quote(mqtt)}`, ...mqttAuth].join("\n"),
    ].join("\n\n");
    const bridgeToml = [
      `[backend]\ntype="semtech_udp"`,
      `[backend.semtech_udp]\nudp_bind="0.0.0.0:1700"`,
      [
        `[integration.mqtt.auth.generic]`,
        `servers=[${quote(mqtt)}]`,
        `username=${quote(auth?.user ?? "")}`,
        `password=${quote(auth?.password ?? "")}`,
      ].join("\n"),
      [
        `[integration.mqtt]`,
        `event_topic_template="${region}/gateway/{{ .GatewayID }}/event/{{ .EventType }}"`,
        `state_topic_template="${region}/gateway/{{ .GatewayID }}/state/{{ .StateType }}"`,
        `command_topic_template="${region}/gateway/{{ .GatewayID }}/command/#"`,
      ].join("\n"),
    ].join("\n\n");

    const r = empty();
    r.containers.push(
      {
        name: "chirpstack-redis",
        description: t("Cache et sessions de ChirpStack", "ChirpStack cache and sessions"),
        options: container({
          image: str(v.redisImage),
          cmd: ["redis-server", "--save", "300", "1"],
          ports: [{ container: "6379/tcp", host: num(v.redisPort) }],
          volumes: [{ volume: "chirpstack-redis", target: "/data" }],
        }),
      },
      {
        name: "chirpstack-postgres",
        description: t("Base de données de ChirpStack (avec l'extension pg_trgm)", "ChirpStack database (with the pg_trgm extension)"),
        options: container({
          image: str(v.postgresImage),
          entrypoint: ["sh", "-c"],
          cmd: [
            `${writeFile("/docker-entrypoint-initdb.d/chirpstack.sql", "CREATE EXTENSION IF NOT EXISTS pg_trgm;")} && exec docker-entrypoint.sh postgres -c listen_addresses='*'`,
          ],
          env: { POSTGRES_USER: "chirpstack", POSTGRES_PASSWORD: str(v.dbPassword), POSTGRES_DB: "chirpstack" },
          ports: [{ container: "5432/tcp", host: num(v.pgPort) }],
          volumes: [{ volume: "chirpstack-pgdata", target: "/var/lib/postgresql/data" }],
        }),
      },
      {
        name: "chirpstack-init",
        description: t("Écrit la configuration de ChirpStack et du Gateway Bridge, puis s'arrête", "Writes the ChirpStack and Gateway Bridge configuration, then exits"),
        oneShot: { removeAfter: true },
        options: container({
          image: str(v.initImage),
          entrypoint: ["sh", "-c"],
          cmd: [
            [
              writeFile("/cs/chirpstack.toml", chirpstackToml),
              writeFile(`/cs/region_${region}.toml`, regionToml),
              writeFile("/gwb/chirpstack-gateway-bridge.toml", bridgeToml),
              "echo done",
            ].join(" && "),
          ],
          restart: "no",
          volumes: [
            { volume: "chirpstack-config", target: "/cs" },
            { volume: "chirpstack-gwb-config", target: "/gwb" },
          ],
        }),
      },
      {
        name: "chirpstack",
        description: t("Serveur réseau LoRaWAN et interface web", "LoRaWAN network server and web UI"),
        options: container({
          image: str(v.image),
          cmd: ["-c", "/etc/chirpstack"],
          ports: [{ container: "8080/tcp", host: num(v.hostPort) }],
          volumes: [{ volume: "chirpstack-config", target: "/etc/chirpstack" }],
        }),
      },
      {
        name: "chirpstack-gateway-bridge",
        description: t("Reçoit les paquets UDP des gateways et les publie en MQTT", "Receives gateway UDP packets and publishes them over MQTT"),
        options: container({
          image: str(v.bridgeImage),
          ports: [{ container: "1700/udp", host: num(v.udpPort) }],
          volumes: [{ volume: "chirpstack-gwb-config", target: "/etc/chirpstack-gateway-bridge" }],
        }),
      },
    );
    if (bool(v.restApi)) {
      r.containers.push({
        name: "chirpstack-rest-api",
        description: t("API REST et Swagger de ChirpStack", "ChirpStack REST API and Swagger"),
        options: container({
          image: str(v.restImage),
          cmd: ["--server", `${apexIp}:${v.hostPort}`, "--bind", "0.0.0.0:8090", "--insecure"],
          ports: [{ container: "8090/tcp", host: num(v.restPort) }],
        }),
      });
      r.links.push({ label: t("API REST ChirpStack (Swagger)", "ChirpStack REST API (Swagger)"), url: `http://${apexIp}:${v.restPort}` });
    }
    r.links.unshift({ label: t("Interface ChirpStack", "ChirpStack UI"), url: `http://${apexIp}:${v.hostPort}` });
    r.credentials.push(
      { label: t("ChirpStack : identifiants par défaut", "ChirpStack: default login"), value: "admin / admin" },
      { label: t("PostgreSQL : mot de passe", "PostgreSQL: password"), value: str(v.dbPassword) },
    );
    r.notes.push(
      t(
        `Côté gateway : packet forwarder Semtech UDP, serveur = ${apexIp}, ports montant et descendant = ${v.udpPort}.`,
        `On the gateway: Semtech UDP packet forwarder, server = ${apexIp}, up and down ports = ${v.udpPort}.`,
      ),
      t("Changez le mot de passe admin de ChirpStack dès la première connexion.", "Change the ChirpStack admin password on first login."),
      t(
        "Les uplinks décodés sont publiés sur Mosquitto : application/+/device/+/event/up.",
        "Decoded uplinks are published to Mosquitto: application/+/device/+/event/up.",
      ),
    );
    return r;
  },
};

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

const nodered: Recipe = {
  id: "nodered",
  name: "Node-RED",
  category: "automation",
  badge: "NR",
  color: "#8f0000",
  status: "validated",
  summary: t("Flows visuels : MQTT ↔ points BACnet de l'APEX.", "Visual flows: MQTT ↔ APEX BACnet points."),
  description: t(
    "Le couteau suisse pour relier MQTT, l'API REST de l'APEX et vos objets BACnet. Modules à préinstaller (ex. LoRaBAC) et éditeur protégé par mot de passe en option.",
    "The Swiss army knife to connect MQTT, the APEX REST API and your BACnet objects. Optional preinstalled modules (e.g. LoRaBAC) and password-protected editor.",
  ),
  ramMb: 150,
  homepage: "https://nodered.org",
  params: [
    hostPortParam(50080),
    {
      id: "adminPassword",
      label: t("Mot de passe de l'éditeur (utilisateur admin)", "Editor password (admin user)"),
      help: t("Laissez vide pour un éditeur sans mot de passe (banc de test).", "Leave empty for an editor without password (test bench)."),
      type: "password",
    },
    {
      id: "modules",
      label: t("Modules à préinstaller", "Modules to preinstall"),
      help: t(
        "Un module npm par ligne, installé au premier démarrage. Ex. @flowfuse/node-red-dashboard, @montagny/node-red-contrib-lorawan-bacnet",
        "One npm module per line, installed on first start. E.g. @flowfuse/node-red-dashboard, @montagny/node-red-contrib-lorawan-bacnet",
      ),
      type: "textarea",
      default: "",
      placeholder: "@flowfuse/node-red-dashboard",
    },
    {
      id: "memory",
      label: t("Mémoire max de Node.js (Mo)", "Node.js max memory (MB)"),
      type: "number",
      default: 128,
      advanced: true,
    },
    timezoneParam,
    imageParam("nodered/node-red:4.1"),
    nameParam("nodered"),
  ],
  build({ apexIp, values: v }) {
    const password = str(v.adminPassword);
    const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~-]+)?$/i;
    const requested = str(v.modules)
      .split(/[\s,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    const modules = requested.filter((m) => NPM_NAME.test(m));
    const ignored = requested.filter((m) => !NPM_NAME.test(m));
    const steps: string[] = [];
    if (password) {
      const settings = `module.exports = {
  flowFile: "flows.json",
  uiPort: process.env.PORT || 1880,
  adminAuth: {
    type: "credentials",
    users: [{ username: "admin", password: ${JSON.stringify(bcrypt(password))}, permissions: "*" }]
  },
  functionExternalModules: true,
  logging: { console: { level: "info", metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false } }
};`;
      steps.push(writeFileOnce("/data/settings.js", settings));
      // settings.js is kept across reinstalls (user edits): only the admin password is refreshed.
      steps.push(`sed -i ${shellQuote(`s#password: "[^"]*", permissions#password: ${JSON.stringify(bcrypt(password))}, permissions#`)} /data/settings.js`);
    }
    if (modules.length) {
      steps.push(
        `cd /data && (npm install --no-audit --no-fund --omit=dev ${modules.join(" ")} >> /data/apexpress-npm.log 2>&1 || echo "npm install failed" >> /data/apexpress-npm.log)`,
      );
    }
    const custom = steps.length > 0;
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        ...(custom ? { entrypoint: ["sh", "-c"], cmd: [[...steps, "cd /usr/src/node-red", "exec ./entrypoint.sh"].join(" && ")] } : {}),
        env: { TZ: str(v.tz), NODE_OPTIONS: `--max_old_space_size=${num(v.memory)}` },
        ports: [{ container: "1880/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: "nodered-data", target: "/data" }],
      }),
    });
    r.links.push({ label: t("Éditeur Node-RED", "Node-RED editor"), url: `http://${apexIp}:${v.hostPort}` });
    if (password) r.credentials.push({ label: t("Node-RED : identifiants", "Node-RED: login"), value: `admin / ${password}` });
    else r.notes.push(t("Éditeur Node-RED sans mot de passe : à protéger sur un site.", "Node-RED editor without password: protect it on a real site."));
    if (ignored.length) {
      r.notes.push(t(`Modules ignorés (nom invalide) : ${ignored.join(", ")}`, `Ignored modules (invalid name): ${ignored.join(", ")}`));
    }
    if (modules.length) {
      r.notes.push(
        t(
          "Les modules s'installent au premier démarrage (quelques minutes, Internet requis). Journal : apexpress-npm.log dans le volume nodered-data.",
          "Modules install on first start (a few minutes, Internet required). Log: apexpress-npm.log in the nodered-data volume.",
        ),
      );
    }
    return r;
  },
};

const eclypseMcp: Recipe = {
  id: "mcp",
  name: "MCP ECLYPSE",
  category: "automation",
  badge: "AI",
  color: "#d97757",
  status: "experimental",
  summary: t("Claude lit vos points BACnet, historiques et programmes horaires.", "Claude reads your BACnet points, histories and schedules."),
  description: t(
    "Serveur MCP (Model Context Protocol) qui donne à Claude l'accès à l'APEX par son API REST : points BACnet locaux et distants, trend logs, programmes horaires, alarmes, état de l'automate, et InfluxDB en option. Lecture seule par défaut ; l'écriture, en option, passe par une simulation puis une confirmation, à une priorité BACnet dédiée. Exemple : « regarde le départ chauffage et la T ext de la semaine, ma loi d'eau est-elle bien réglée ? »",
    "MCP (Model Context Protocol) server giving Claude access to the APEX through its REST API: local and remote BACnet points, trend logs, schedules, alarms, controller state, and InfluxDB as an option. Read-only by default; optional writes go through a dry run then a confirmation, at a dedicated BACnet priority. Example: \"look at the heating supply and outdoor temperature over the week, is my heating curve right?\"",
  ),
  ramMb: 60,
  homepage: "https://modelcontextprotocol.io",
  troubleshooting: [
    t(
      "« APEX 401 » dans les réponses : l'utilisateur ou le mot de passe de l'APEX saisis ici sont refusés. « APEX 403 » : ce compte n'a pas le droit de lire cette ressource.",
      "\"APEX 401\" in answers: the APEX user or password entered here is rejected. \"APEX 403\": this account is not allowed to read this resource.",
    ),
    t(
      "« Password reset required » : l'APEX impose un changement de mot de passe à la première connexion des nouveaux comptes. Connectez-vous une fois avec ce compte sur l'interface web de l'APEX (ou décochez « réinitialiser le mot de passe » dans Utilisateurs), puis réinstallez le MCP avec « Le remplacer » et le mot de passe définitif.",
      "\"Password reset required\": the APEX forces new accounts to change their password at first login. Log in once with this account on the APEX web interface (or untick \"reset password\" in Users), then reinstall the MCP with \"Replace\" and the final password.",
    ),
    t(
      "Claude reçoit 401 / « invalid_token » : le jeton ne correspond pas. Il est dans les identifiants affichés après l'installation.",
      "Claude gets 401 / \"invalid_token\": the token does not match. It is in the credentials shown after the install.",
    ),
    t(
      "claude.ai et l'appli mobile n'atteignent pas le réseau local : passez par Cloudflare Tunnel (HTTPS) vers ce port, et utilisez l'URL avec le jeton dans le chemin (/mcp/<jeton>).",
      "claude.ai and the mobile app cannot reach the local network: go through Cloudflare Tunnel (HTTPS) to this port, and use the URL with the token in the path (/mcp/<token>).",
    ),
    t(
      "Les noms de points viennent de votre programmation : faites noter à Claude le rôle des points clés (outil save_site_notes), il s'en servira dans les analyses suivantes.",
      "Point names come from your programming: have Claude note the role of key points (save_site_notes tool), it will use them in later analyses.",
    ),
  ],
  params: [
    hostPortParam(50089),
    {
      id: "apexUser",
      label: t("Utilisateur de l'APEX", "APEX user"),
      help: t(
        "Compte avec lequel le serveur lit l'API REST de l'APEX. Créez-en un dédié (Utilisateurs de l'APEX), avec le moins de droits possible.",
        "Account the server uses to read the APEX REST API. Create a dedicated one (APEX users), with as few rights as possible.",
      ),
      type: "text",
      required: true,
      placeholder: "mcp",
    },
    { id: "apexPassword", label: t("Mot de passe de cet utilisateur", "Password of this user"), type: "password", required: true },
    {
      id: "token",
      label: t("Jeton d'accès MCP", "MCP access token"),
      help: t("Secret à donner à Claude. Laissez vide pour en générer un.", "Secret to give to Claude. Leave empty to generate one."),
      type: "password",
      generate: "token",
    },
    {
      id: "allowWrite",
      label: t("Autoriser l'écriture de valeurs", "Allow writing values"),
      help: t(
        "Ajoute les outils d'écriture : commander un point (AV, BV, MSV, AO, BO, MSO, locaux ou distants), modifier une propriété, un programme horaire, créer des objets, intégrer des équipements BACnet (import EDE) et Modbus, lier les network values GFX (et supprimer seulement ce que le MCP a créé). Simulation d'abord, écriture seulement après confirmation, priorités 1 à 7 interdites. Chaque écriture est journalisée (writes.log, volume mcp-data).",
        "Adds the write tools: command a point (AV, BV, MSV, AO, BO, MSO, local or remote), change a property or a schedule, create objects, integrate BACnet (EDE import) and Modbus devices, bind GFX network values (and delete only what the MCP created). Dry run first, write only after confirmation, priorities 1 to 7 refused. Every write is logged (writes.log, mcp-data volume).",
      ),
      type: "boolean",
      default: false,
    },
    {
      id: "writePriority",
      label: t("Priorité BACnet d'écriture", "BACnet write priority"),
      help: t("16 (la plus faible) par défaut : la programmation et les forçages gardent la main.", "16 (lowest) by default: programming and overrides keep control."),
      type: "number",
      default: 16,
      advanced: true,
    },
    {
      id: "autoBackupHours",
      label: t("Sauvegarde automatique avant modification (heures)", "Automatic backup before a change (hours)"),
      help: t(
        "Avant une modification de configuration (import, création, alarmes…), le MCP fait une sauvegarde de l'APEX si la dernière date de plus de ce délai. 5 sont gardées. 0 : désactivé.",
        "Before a configuration change (import, creation, alarms…), the MCP backs up the APEX if the last backup is older than this. 5 are kept. 0: disabled.",
      ),
      type: "number",
      default: 12,
      advanced: true,
    },
    {
      id: "writeAllow",
      label: t("Liste blanche d'écriture (optionnel)", "Write whitelist (optional)"),
      help: t(
        "Expression régulière sur le nom des objets que Claude peut écrire, ex. ^CSG_|_Consigne$. Vide : tous les objets commandables.",
        "Regular expression on the names of the objects Claude may write, e.g. ^SP_|_Setpoint$. Empty: every commandable object.",
      ),
      type: "text",
      default: "",
      advanced: true,
    },
    {
      id: "influxToken",
      label: t("Token InfluxDB (optionnel)", "InfluxDB token (optional)"),
      help: t(
        "Pour interroger aussi l'InfluxDB installé par Open Apexpress (outil query_influx, en lecture seule). Le token est dans les identifiants d'InfluxDB.",
        "To also query the InfluxDB installed by Open Apexpress (query_influx tool, read-only). The token is in the InfluxDB credentials.",
      ),
      type: "password",
      advanced: true,
    },
    {
      id: "apexUrl",
      label: t("Adresse de l'API de l'APEX", "APEX API address"),
      help: t("Vide : https://<IP de l'APEX>.", "Empty: https://<APEX IP>."),
      type: "text",
      default: "",
      advanced: true,
    },
    imageParam("node:22-alpine"),
    nameParam("mcp"),
  ],
  build({ apexIp, values: v, all }) {
    const port = num(v.hostPort);
    const token = str(v.token);
    const influx = all.influxdb;
    const influxToken = str(v.influxToken);
    const url = `http://${apexIp}:${port}/mcp`;
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        entrypoint: ["sh", "-c"],
        cmd: [`mkdir -p /srv && echo '${MCP_SERVER_PACKED}' | base64 -d | gunzip > /srv/eclypse-mcp.mjs && exec node /srv/eclypse-mcp.mjs`],
        env: {
          APEX_URL: str(v.apexUrl) || `https://${apexIp}`,
          APEX_USER: str(v.apexUser),
          APEX_PASSWORD: str(v.apexPassword),
          MCP_TOKEN: token,
          ALLOW_WRITE: bool(v.allowWrite) ? "true" : "false",
          WRITE_PRIORITY: num(v.writePriority),
          WRITE_ALLOW: str(v.writeAllow) || undefined,
          AUTO_BACKUP_HOURS: num(v.autoBackupHours),
          INFLUX_URL: influxToken ? `http://${apexIp}:${influx?.hostPort ?? 50086}` : undefined,
          INFLUX_TOKEN: influxToken || undefined,
          INFLUX_ORG: influxToken ? str(influx?.org ?? "apex") : undefined,
          INFLUX_BUCKET: influxToken ? str(influx?.bucket ?? "apex") : undefined,
          PORT: 8080,
          DATA_DIR: "/data",
          NODE_OPTIONS: "--max-old-space-size=64",
        },
        ports: [{ container: "8080/tcp", host: port }],
        volumes: [{ volume: "mcp-data", target: "/data" }],
      }),
    });
    r.links.push({ label: t("Serveur MCP (état)", "MCP server (status)"), url: `http://${apexIp}:${port}` });
    r.credentials.push(
      { label: t("MCP : URL", "MCP: URL"), value: url },
      { label: t("MCP : jeton (en-tête Authorization: Bearer)", "MCP: token (Authorization: Bearer header)"), value: token },
      {
        label: t("Claude Code : commande à lancer", "Claude Code: command to run"),
        value: `claude mcp add --transport http eclypse ${url} --header "Authorization: Bearer ${token}"`,
      },
      {
        label: t("Claude Desktop : bloc à ajouter dans mcpServers", "Claude Desktop: block to add to mcpServers"),
        value: `"eclypse": { "command": "npx", "args": ["-y", "mcp-remote", "${url}", "--allow-http", "--header", "Authorization: Bearer ${token}"] }`,
      },
    );
    r.notes.push(
      t(
        "Claude Desktop : Paramètres › Développeur › Modifier la configuration, collez le bloc ci-dessus dans \"mcpServers\" puis redémarrez Claude (Node.js requis sur le PC).",
        "Claude Desktop: Settings › Developer › Edit config, paste the block above into \"mcpServers\" then restart Claude (Node.js needed on the PC).",
      ),
      t(
        `claude.ai / mobile : connecteur personnalisé vers une adresse HTTPS publique (Cloudflare Tunnel vers http://${apexIp}:${port}), au format https://<votre-domaine>/mcp/<jeton>. Jamais de port ouvert en direct sur Internet.`,
        `claude.ai / mobile: custom connector to a public HTTPS address (Cloudflare Tunnel to http://${apexIp}:${port}), as https://<your-domain>/mcp/<token>. Never open the port directly to the Internet.`,
      ),
      t(
        "Sur le réseau local la connexion est en HTTP : le jeton y circule en clair. Réservez-la à un réseau de confiance, sinon passez par le tunnel.",
        "On the local network the connection is plain HTTP: the token travels in clear. Keep it to a trusted network, otherwise use the tunnel.",
      ),
      bool(v.allowWrite)
        ? t(
            `Écriture activée, à la priorité BACnet ${v.writePriority} : Claude simule d'abord et n'écrit qu'après votre accord.`,
            `Writing enabled, at BACnet priority ${v.writePriority}: Claude dry-runs first and only writes after your approval.`,
          )
        : t("Lecture seule : Claude ne peut rien écrire dans l'automate.", "Read-only: Claude cannot write anything to the controller."),
    );
    return r;
  },
};

const ntfy: Recipe = {
  id: "ntfy",
  name: "ntfy",
  category: "automation",
  badge: "NT",
  color: "#338574",
  status: "experimental",
  summary: t("Notifications push sur smartphone, sans cloud.", "Push notifications to smartphones, no cloud."),
  description: t(
    "Envoyez une alarme sur le téléphone du technicien d'un simple POST HTTP (depuis Node-RED, Grafana, Uptime Kuma…). Application ntfy sur Android et iOS.",
    "Send an alarm to the technician's phone with a simple HTTP POST (from Node-RED, Grafana, Uptime Kuma…). ntfy app on Android and iOS.",
  ),
  ramMb: 25,
  homepage: "https://ntfy.sh",
  params: [hostPortParam(50093), timezoneParam, imageParam("binwiederhier/ntfy:v2.30.0"), nameParam("ntfy")],
  build({ apexIp, values: v }) {
    const url = `http://${apexIp}:${v.hostPort}`;
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        cmd: ["serve"],
        env: {
          TZ: str(v.tz),
          NTFY_BASE_URL: url,
          NTFY_CACHE_FILE: "/var/cache/ntfy/cache.db",
          NTFY_ATTACHMENT_CACHE_DIR: "/var/cache/ntfy/attachments",
        },
        ports: [{ container: "80/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: "ntfy-cache", target: "/var/cache/ntfy" }],
      }),
    });
    r.links.push({ label: t("Interface ntfy", "ntfy UI"), url });
    r.notes.push(
      t(
        `Test : curl -d "Alarme chaufferie" ${url}/gtb, puis abonnez l'appli ntfy au sujet « gtb » sur ce serveur.`,
        `Test: curl -d "Boiler room alarm" ${url}/gtb, then subscribe the ntfy app to the "gtb" topic on this server.`,
      ),
    );
    return r;
  },
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const influxdb: Recipe = {
  id: "influxdb",
  name: "InfluxDB",
  category: "data",
  badge: "IX",
  color: "#9b2aff",
  status: "validated",
  summary: t("Base de données de séries temporelles.", "Time series database."),
  description: t(
    "Stocke les mesures collectées par Telegraf. Rétention courte conseillée : l'APEX n'est pas un serveur d'archives.",
    "Stores the measurements collected by Telegraf. Keep a short retention: the APEX is not an archive server.",
  ),
  ramMb: 250,
  homepage: "https://www.influxdata.com",
  params: [
    hostPortParam(50086),
    { id: "org", label: t("Organisation", "Organization"), type: "text", default: "apex" },
    { id: "bucket", label: t("Bucket", "Bucket"), type: "text", default: "apex" },
    {
      id: "retention",
      label: t("Rétention", "Retention"),
      type: "select",
      default: "30d",
      options: [
        { value: "7d", label: t("7 jours", "7 days") },
        { value: "30d", label: t("30 jours", "30 days") },
        { value: "90d", label: t("90 jours", "90 days") },
        { value: "365d", label: t("1 an", "1 year") },
      ],
    },
    { id: "user", label: t("Administrateur", "Admin user"), type: "text", default: "admin", advanced: true },
    passwordParam("password", t("Mot de passe administrateur", "Admin password"), true),
    {
      id: "token",
      label: t("Jeton d'API (token)", "API token"),
      type: "password",
      generate: "token",
      advanced: true,
    },
    imageParam("influxdb:2.7"),
    nameParam("influxdb"),
  ],
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        env: {
          DOCKER_INFLUXDB_INIT_MODE: "setup",
          DOCKER_INFLUXDB_INIT_USERNAME: str(v.user),
          DOCKER_INFLUXDB_INIT_PASSWORD: str(v.password),
          DOCKER_INFLUXDB_INIT_ORG: str(v.org),
          DOCKER_INFLUXDB_INIT_BUCKET: str(v.bucket),
          DOCKER_INFLUXDB_INIT_RETENTION: str(v.retention),
          DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: str(v.token),
        },
        ports: [{ container: "8086/tcp", host: num(v.hostPort) }],
        volumes: [
          { volume: "influxdb-data", target: "/var/lib/influxdb2" },
          { volume: "influxdb-config", target: "/etc/influxdb2" },
        ],
      }),
    });
    r.links.push({ label: t("Interface InfluxDB", "InfluxDB UI"), url: `http://${apexIp}:${v.hostPort}` });
    r.credentials.push(
      { label: t("InfluxDB : identifiants", "InfluxDB: login"), value: `${v.user} / ${v.password}` },
      { label: t("InfluxDB : token", "InfluxDB: token"), value: str(v.token) },
    );
    r.notes.push(
      t(
        "Les identifiants et le token ne sont appliqués qu'à la toute première initialisation du volume influxdb-data.",
        "Credentials and token are only applied on the very first initialization of the influxdb-data volume.",
      ),
    );
    return r;
  },
};

const telegraf: Recipe = {
  id: "telegraf",
  name: "Telegraf",
  category: "data",
  badge: "TG",
  color: "#22adf6",
  status: "validated",
  summary: t("Collecte les mesures MQTT vers InfluxDB.", "Collects MQTT measurements into InfluxDB."),
  description: t(
    "S'abonne à Mosquitto (Zigbee2MQTT, ChirpStack, sujets libres) et écrit les valeurs numériques dans InfluxDB. Configuration générée automatiquement.",
    "Subscribes to Mosquitto (Zigbee2MQTT, ChirpStack, custom topics) and writes numeric values to InfluxDB. Configuration generated automatically.",
  ),
  ramMb: 60,
  requires: ["mosquitto", "influxdb"],
  homepage: "https://www.influxdata.com/time-series-platform/telegraf/",
  params: [
    { id: "zigbee", label: t("Collecter Zigbee2MQTT", "Collect Zigbee2MQTT"), help: t("Sujets zigbee2mqtt/+", "Topics zigbee2mqtt/+"), type: "boolean", default: true },
    {
      id: "lorawan",
      label: t("Collecter ChirpStack (LoRaWAN)", "Collect ChirpStack (LoRaWAN)"),
      help: t("Uplinks décodés application/+/device/+/event/up", "Decoded uplinks application/+/device/+/event/up"),
      type: "boolean",
      default: true,
    },
    {
      id: "topics",
      label: t("Autres sujets MQTT (JSON)", "Other MQTT topics (JSON)"),
      help: t("Un sujet par ligne, messages JSON.", "One topic per line, JSON payloads."),
      type: "textarea",
      default: "",
      placeholder: "site/+/mesures",
    },
    {
      id: "interval",
      label: t("Intervalle d'écriture", "Write interval"),
      type: "select",
      default: "10s",
      options: ["5s", "10s", "30s", "60s"].map((s) => ({ value: s, label: t(s, s) })),
      advanced: true,
    },
    imageParam("telegraf:1.32"),
    nameParam("telegraf"),
  ],
  build({ apexIp, values: v, all }) {
    const influx = all.influxdb ?? {};
    const auth = mosquittoAuth(all);
    const broker = mosquittoUrl(apexIp, all, "tcp");
    const consumer = (topics: string[], name: string, extra: string[] = []) =>
      [
        "[[inputs.mqtt_consumer]]",
        `  servers = [${quote(broker)}]`,
        `  topics = [${topics.map((x) => quote(x)).join(", ")}]`,
        ...(auth ? [`  username = ${quote(auth.user)}`, `  password = ${quote(auth.password)}`] : []),
        '  data_format = "json"',
        `  name_override = ${quote(name)}`,
        ...extra.map((e) => `  ${e}`),
      ].join("\n");
    const blocks = [
      `[agent]\n  interval = ${quote(v.interval)}\n  flush_interval = ${quote(v.interval)}\n  omit_hostname = true`,
      [
        "[[outputs.influxdb_v2]]",
        `  urls = [${quote(`http://${apexIp}:${influx.hostPort ?? 50086}`)}]`,
        `  token = ${quote(influx.token)}`,
        `  organization = ${quote(influx.org)}`,
        `  bucket = ${quote(influx.bucket)}`,
      ].join("\n"),
    ];
    if (bool(v.zigbee)) blocks.push(consumer(["zigbee2mqtt/+"], "zigbee"));
    if (bool(v.lorawan)) blocks.push(consumer(["application/+/device/+/event/up"], "lorawan", ['json_query = "object"']));
    const custom = str(v.topics)
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (custom.length) blocks.push(consumer(custom, "mqtt"));

    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        entrypoint: ["sh", "-c"],
        cmd: [`${writeFile("/etc/telegraf/telegraf.conf", blocks.join("\n\n"))} && exec telegraf --config /etc/telegraf/telegraf.conf`],
      }),
    });
    r.notes.push(
      t(
        "Telegraf ne garde que les champs numériques des messages JSON. Le sujet MQTT est conservé en tag.",
        "Telegraf only keeps numeric fields of JSON messages. The MQTT topic is kept as a tag.",
      ),
    );
    return r;
  },
};

const grafana: Recipe = {
  id: "grafana",
  name: "Grafana",
  category: "data",
  badge: "GF",
  color: "#f46800",
  status: "validated",
  summary: t("Tableaux de bord, branché sur InfluxDB.", "Dashboards, wired to InfluxDB."),
  description: t(
    "De jolies courbes servies par l'automate. Si InfluxDB est installé avec, la source de données est créée automatiquement.",
    "Nice charts served by the controller. When InfluxDB is installed alongside, the data source is created automatically.",
  ),
  ramMb: 200,
  homepage: "https://grafana.com",
  params: [
    hostPortParam(50030),
    passwordParam("password", t("Mot de passe admin", "Admin password")),
    imageParam("grafana/grafana:11.2.0"),
    nameParam("grafana"),
  ],
  build({ apexIp, values: v, all }) {
    const influx = all.influxdb;
    const r = empty();
    const env = {
      GF_SECURITY_ADMIN_PASSWORD: str(v.password),
      GF_ANALYTICS_REPORTING_ENABLED: "false",
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false",
      GF_PATHS_PROVISIONING: influx ? "/var/lib/grafana/provisioning" : undefined,
    };
    let provisioning: { entrypoint: string[]; cmd: string[] } | undefined;
    if (influx) {
      const datasource = [
        "apiVersion: 1",
        "datasources:",
        "  - name: InfluxDB (APEX)",
        "    uid: apexpress-influxdb",
        "    type: influxdb",
        "    access: proxy",
        `    url: http://${apexIp}:${influx.hostPort}`,
        "    isDefault: true",
        "    jsonData:",
        "      version: Flux",
        `      organization: ${quote(influx.org)}`,
        `      defaultBucket: ${quote(influx.bucket)}`,
        "    secureJsonData:",
        `      token: ${quote(influx.token)}`,
      ].join("\n");
      const dirs = ["dashboards", "plugins", "alerting", "notifiers"].map((d) => `/var/lib/grafana/provisioning/${d}`).join(" ");
      provisioning = {
        entrypoint: ["sh", "-c"],
        cmd: [`mkdir -p ${dirs} && ${writeFile("/var/lib/grafana/provisioning/datasources/apexpress.yaml", datasource)} && exec /run.sh`],
      };
    }
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        ...provisioning,
        env,
        ports: [{ container: "3000/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: "grafana-data", target: "/var/lib/grafana" }],
      }),
    });
    r.links.push({ label: t("Grafana", "Grafana"), url: `http://${apexIp}:${v.hostPort}` });
    r.credentials.push({ label: t("Grafana : identifiants", "Grafana: login"), value: `admin / ${v.password}` });
    if (influx) {
      r.notes.push(t("Source de données « InfluxDB (APEX) » créée, en langage Flux.", "Data source \"InfluxDB (APEX)\" created, using Flux."));
    }
    return r;
  },
};

// ---------------------------------------------------------------------------
// Remote access
// ---------------------------------------------------------------------------

const cloudflared: Recipe = {
  id: "cloudflared",
  name: "Cloudflare Tunnel",
  category: "remote",
  badge: "CF",
  color: "#f38020",
  status: "validated",
  summary: t("Accès distant sans ouvrir de port, même en 4G.", "Remote access without opening ports, even over 4G."),
  description: t(
    "Tunnel sortant vers Cloudflare Zero Trust : l'interface de l'APEX et vos services accessibles depuis le bureau. 1 tunnel = 1 token = 1 site.",
    "Outbound tunnel to Cloudflare Zero Trust: reach the APEX UI and your services from the office. 1 tunnel = 1 token = 1 site.",
  ),
  ramMb: 30,
  homepage: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
  params: [
    {
      id: "token",
      label: t("Token du tunnel", "Tunnel token"),
      help: t("Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.", "Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared."),
      type: "password",
      required: true,
    },
    imageParam("cloudflare/cloudflared:latest"),
    nameParam("cloudflared"),
  ],
  build({ values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({ image: str(v.image), cmd: ["tunnel", "--no-autoupdate", "run", "--token", str(v.token)] }),
    });
    r.notes.push(
      t(
        "Dans Cloudflare : Public Hostnames → ex. apex.votredomaine.fr vers https://localhost:443 (No TLS Verify), nodered.votredomaine.fr vers http://localhost:50080. Protégez avec Cloudflare Access.",
        "In Cloudflare: Public Hostnames → e.g. apex.yourdomain.com to https://localhost:443 (No TLS Verify), nodered.yourdomain.com to http://localhost:50080. Protect with Cloudflare Access.",
      ),
    );
    return r;
  },
};

const tailscale: Recipe = {
  id: "tailscale",
  name: "Tailscale",
  category: "remote",
  badge: "TS",
  color: "#242424",
  status: "validated",
  summary: t("VPN maillé : l'APEX dans votre réseau privé.", "Mesh VPN: the APEX in your private network."),
  description: t(
    "Mode « userspace » (sans privilège ni module noyau). L'APEX est annoncé comme route : depuis votre PC Tailscale, ouvrez directement https://IP_APEX.",
    "Userspace mode (no privileges, no kernel module). The APEX is advertised as a route: from your Tailscale PC, open https://APEX_IP directly.",
  ),
  ramMb: 40,
  homepage: "https://tailscale.com",
  params: [
    {
      id: "authKey",
      label: t("Clé d'authentification", "Auth key"),
      help: t("Console Tailscale → Settings → Keys → Generate auth key.", "Tailscale admin console → Settings → Keys → Generate auth key."),
      type: "password",
      required: true,
    },
    { id: "hostname", label: t("Nom de la machine", "Machine name"), type: "text", default: "eclypse-apex" },
    {
      id: "routes",
      label: t("Routes annoncées", "Advertised routes"),
      help: t("Vide = l'APEX seul (IP/32). Ex. 192.168.1.0/24 pour tout le réseau GTB.", "Empty = the APEX alone (IP/32). E.g. 192.168.1.0/24 for the whole BMS network."),
      type: "text",
      default: "",
      advanced: true,
    },
    imageParam("tailscale/tailscale:stable"),
    nameParam("tailscale"),
  ],
  build({ apexIp, values: v }) {
    const routes = str(v.routes) || `${apexIp}/32`;
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        env: {
          TS_AUTHKEY: str(v.authKey),
          TS_HOSTNAME: str(v.hostname),
          TS_USERSPACE: "true",
          TS_STATE_DIR: "/var/lib/tailscale",
          TS_ROUTES: routes,
        },
        volumes: [{ volume: "tailscale-state", target: "/var/lib/tailscale" }],
      }),
    });
    r.notes.push(
      t(
        `Approuvez la route ${routes} dans la console Tailscale (Machines → ${v.hostname} → Edit route settings).`,
        `Approve the ${routes} route in the Tailscale console (Machines → ${v.hostname} → Edit route settings).`,
      ),
    );
    return r;
  },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const filebrowser: Recipe = {
  id: "filebrowser",
  name: "FileBrowser",
  category: "tools",
  badge: "FB",
  color: "#40c4ff",
  status: "validated",
  summary: t("Explorateur de fichiers d'un volume : logs, configs.", "File explorer for a volume: logs, configs."),
  description: t(
    "Pas de SSH ni de docker logs sur l'APEX : FileBrowser monté sur un volume permet de lire les journaux et les configurations. Il ne peut modifier que les fichiers ouverts en écriture (c'est le cas de la configuration de Zigbee2MQTT). À arrêter après le dépannage.",
    "No SSH nor docker logs on the APEX: FileBrowser mounted on a volume lets you read logs and configurations. It can only edit writable files (Zigbee2MQTT's configuration is). Stop it after troubleshooting.",
  ),
  ramMb: 20,
  homepage: "https://filebrowser.org",
  params: [
    {
      id: "volume",
      label: t("Volume à explorer", "Volume to browse"),
      help: t("Nom d'un volume existant, ex. z2m-data, nodered-data, chirpstack-config.", "Name of an existing volume, e.g. z2m-data, nodered-data, chirpstack-config."),
      type: "text",
      default: "z2m-data",
      required: true,
    },
    hostPortParam(50092),
    imageParam("filebrowser/filebrowser:v2"),
    nameParam("filebrowser"),
  ],
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        cmd: ["--noauth"],
        ports: [{ container: "80/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: str(v.volume), target: "/srv" }],
      }),
    });
    r.links.push({ label: t("FileBrowser", "FileBrowser"), url: `http://${apexIp}:${v.hostPort}` });
    r.notes.push(
      t(
        "FileBrowser est sans authentification : arrêtez-le une fois le dépannage terminé (onglet « Sur l'APEX »).",
        "FileBrowser runs without authentication: stop it once troubleshooting is over (\"On the APEX\" tab).",
      ),
    );
    return r;
  },
};

const uptimeKuma: Recipe = {
  id: "uptimekuma",
  name: "Uptime Kuma",
  category: "tools",
  badge: "UK",
  color: "#5cdd8b",
  status: "experimental",
  summary: t("Surveille automates, passerelles et serveurs.", "Monitors controllers, gateways and servers."),
  description: t(
    "Ping, HTTP, ports TCP, MQTT… avec historique et alertes (ntfy, mail, Teams). Idéal pour savoir quel équipement du site est tombé.",
    "Ping, HTTP, TCP ports, MQTT… with history and alerts (ntfy, mail, Teams). Great to know which device on site went down.",
  ),
  ramMb: 120,
  homepage: "https://uptime.kuma.pet",
  params: [hostPortParam(50095), timezoneParam, imageParam("louislam/uptime-kuma:1"), nameParam("uptime-kuma")],
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        env: { TZ: str(v.tz) },
        ports: [{ container: "3001/tcp", host: num(v.hostPort) }],
        volumes: [{ volume: "uptime-kuma", target: "/app/data" }],
      }),
    });
    r.links.push({ label: t("Uptime Kuma", "Uptime Kuma"), url: `http://${apexIp}:${v.hostPort}` });
    r.notes.push(t("Créez le compte administrateur à la première connexion.", "Create the admin account on first login."));
    return r;
  },
};

const netdata: Recipe = {
  id: "netdata",
  name: "Netdata",
  category: "tools",
  badge: "ND",
  color: "#00ab44",
  status: "experimental",
  summary: t("Charge CPU, RAM et disque de l'APEX en temps réel.", "Real-time APEX CPU, RAM and disk load."),
  description: t(
    "La recette fournie par Distech dans sa collection d'exemples. Pratique pour vérifier que vos conteneurs tiennent dans les 2 Go de RAM.",
    "The recipe provided by Distech in its examples collection. Handy to check your containers fit in the 2 GB of RAM.",
  ),
  ramMb: 150,
  homepage: "https://www.netdata.cloud",
  params: [hostPortParam(50099), imageParam("netdata/netdata:stable"), nameParam("netdata")],
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        ports: [{ container: "19999/tcp", host: num(v.hostPort) }],
        volumes: [
          { volume: "netdataconfig", target: "/etc/netdata" },
          { volume: "netdatalib", target: "/var/lib/netdata" },
          { volume: "netdatacache", target: "/var/cache/netdata" },
        ],
      }),
    });
    r.containers[0]!.options.HostConfig!.LogConfig = { Type: "none", Config: {} };
    r.links.push({ label: t("Netdata", "Netdata"), url: `http://${apexIp}:${v.hostPort}` });
    return r;
  },
};

const nginxProxyManager: Recipe = {
  id: "npm",
  name: "Nginx Proxy Manager",
  category: "tools",
  badge: "NP",
  color: "#f15833",
  status: "experimental",
  summary: t("Proxy inverse et certificats, en interface web.", "Reverse proxy and certificates, with a web UI."),
  description: t(
    "Regroupe vos services derrière des noms (grafana.site.local…) et gère les certificats. Recette inspirée de la collection d'exemples Distech.",
    "Puts your services behind names (grafana.site.local…) and manages certificates. Recipe based on the Distech examples collection.",
  ),
  ramMb: 150,
  homepage: "https://nginxproxymanager.com",
  params: [
    hostPortParam(50281, t("Port de l'interface d'administration", "Admin UI port")),
    { id: "httpPort", label: t("Port HTTP", "HTTP port"), type: "number", default: 50280 },
    { id: "httpsPort", label: t("Port HTTPS", "HTTPS port"), type: "number", default: 50243 },
    imageParam("jc21/nginx-proxy-manager:2"),
    nameParam("nginx-proxy-manager"),
  ],
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({
      name: str(v.name),
      options: container({
        image: str(v.image),
        ports: [
          { container: "81/tcp", host: num(v.hostPort) },
          { container: "80/tcp", host: num(v.httpPort) },
          { container: "443/tcp", host: num(v.httpsPort) },
        ],
        volumes: [
          { volume: "npm-data", target: "/data" },
          { volume: "npm-letsencrypt", target: "/etc/letsencrypt" },
        ],
      }),
    });
    r.links.push({ label: t("Administration NPM", "NPM admin"), url: `http://${apexIp}:${v.hostPort}` });
    r.notes.push(t("Créez le compte administrateur à la première connexion.", "Create the admin account on first login."));
    return r;
  },
};

const portal: Recipe = {
  id: "portal",
  name: "Portail APEX",
  category: "tools",
  badge: "PA",
  color: "#0f766e",
  status: "validated",
  summary: t("Une page d'accueil avec les liens de tous les services.", "A home page linking every service."),
  description: t(
    "Mini serveur web (nginx, 5 Mo de RAM) qui affiche les liens des services installés par Open Apexpress, les ports et les notes utiles. À mettre en favori sur site.",
    "Tiny web server (nginx, 5 MB of RAM) listing links to the services installed by Open Apexpress, the ports and useful notes. Bookmark it on site.",
  ),
  ramMb: 5,
  params: [
    { id: "title", label: t("Titre", "Title"), type: "text", default: "ECLYPSE APEX" },
    hostPortParam(50050),
    imageParam("nginx:alpine"),
    nameParam("portal"),
  ],
  // The real content is filled in by the planner, which knows every link of the plan.
  build({ apexIp, values: v }) {
    const r = empty();
    r.containers.push({ name: str(v.name), options: container({ image: str(v.image), ports: [{ container: "80/tcp", host: num(v.hostPort) }] }) });
    r.links.push({ label: t("Portail APEX", "APEX portal"), url: `http://${apexIp}:${v.hostPort}` });
    return r;
  },
};

export const RECIPES: Recipe[] = [
  mosquitto,
  mqttWeb,
  zigbee2mqtt,
  chirpstack,
  nodered,
  eclypseMcp,
  ntfy,
  influxdb,
  telegraf,
  grafana,
  cloudflared,
  tailscale,
  filebrowser,
  uptimeKuma,
  netdata,
  nginxProxyManager,
  portal,
];

export const PACKS: Pack[] = [
  {
    id: "zigbee",
    name: t("Pack Zigbee", "Zigbee pack"),
    description: t("Mosquitto, Zigbee2MQTT et Node-RED : vos modules Zigbee dans la GTB.", "Mosquitto, Zigbee2MQTT and Node-RED: your Zigbee devices in the BMS."),
    recipes: ["mosquitto", "zigbee2mqtt", "nodered"],
  },
  {
    id: "lorawan",
    name: t("Pack LoRaWAN", "LoRaWAN pack"),
    description: t("Mosquitto, ChirpStack et Node-RED : un serveur LoRaWAN dans l'armoire.", "Mosquitto, ChirpStack and Node-RED: a LoRaWAN server in the panel."),
    recipes: ["mosquitto", "chirpstack", "nodered"],
  },
  {
    id: "charts",
    name: t("Pack Courbes", "Charts pack"),
    description: t("Telegraf, InfluxDB et Grafana, câblés entre eux.", "Telegraf, InfluxDB and Grafana, wired together."),
    recipes: ["mosquitto", "influxdb", "telegraf", "grafana"],
  },
  {
    id: "remote",
    name: t("Pack Maintenance", "Maintenance pack"),
    description: t("Tunnel Cloudflare, Uptime Kuma et ntfy : accès distant et alertes.", "Cloudflare Tunnel, Uptime Kuma and ntfy: remote access and alerts."),
    recipes: ["cloudflared", "uptimekuma", "ntfy"],
  },
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);

export { shellQuote };
