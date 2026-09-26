import { afterEach, describe, expect, it } from "vitest";
import http from "http";
import net from "net";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const openServers = new Set();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      openServers.add(server);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => {
    openServers.delete(server);
    resolve();
  }));
}

function createSocks5TunnelServer() {
  return net.createServer((client) => {
    let phase = "greeting";
    let buffered = Buffer.alloc(0);

    client.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (phase === "greeting") {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return;
        buffered = buffered.subarray(2 + buffered[1]);
        client.write(Buffer.from([5, 0]));
        phase = "connect";
      }
      if (phase !== "connect" || buffered.length < 7) return;

      const addressType = buffered[3];
      let addressLength = 4;
      if (addressType === 3) {
        if (buffered.length < 5) return;
        addressLength = 1 + buffered[4];
      } else if (addressType !== 1) {
        client.destroy(new Error(`Unexpected SOCKS address type ${addressType}`));
        return;
      } else {
        addressLength = 4;
      }
      const portOffset = 4 + addressLength;
      if (buffered.length < portOffset + 2) return;
      const destinationPort = buffered.readUInt16BE(portOffset);
      buffered = buffered.subarray(portOffset + 2);
      phase = "tunnel";

      const upstream = net.connect(destinationPort, "127.0.0.1", () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (buffered.length) upstream.write(buffered);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", (error) => client.destroy(error));
      client.once("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy());
    });
  });
}

afterEach(async () => {
  await Promise.all([...openServers].map(close));
});

describe("proxyAwareFetch SOCKS5 routing", () => {
  it("sends the request through a SOCKS5 tunnel", async () => {
    let targetRequests = 0;
    const target = http.createServer((_req, res) => {
      targetRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ routed: true }));
    });
    const targetPort = await listen(target);
    const socks = createSocks5TunnelServer();
    const proxyPort = await listen(socks);

    const response = await proxyAwareFetch(`http://127.0.0.1:${targetPort}/probe`, {
      method: "GET",
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: `socks5://127.0.0.1:${proxyPort}`,
      strictProxy: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ routed: true });
    expect(targetRequests).toBe(1);
  });

  it("rejects an account-isolated request with no assigned proxy before direct fetch", async () => {
    let directRequests = 0;
    const target = http.createServer((_req, res) => {
      directRequests++;
      res.end("direct");
    });
    const targetPort = await listen(target);

    await expect(proxyAwareFetch(`http://127.0.0.1:${targetPort}/probe`, {
      method: "GET",
    }, { strictProxy: true, requireAccountProxy: true })).rejects.toThrow(/no connection proxy is configured/);

    expect(directRequests).toBe(0);
  });

  it("still refuses when only a shared env proxy is available", async () => {
    let directRequests = 0;
    const target = http.createServer((_req, res) => {
      directRequests++;
      res.end("direct");
    });
    const targetPort = await listen(target);
    const envKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
    const savedEnv = envKeys.map((key) => [key, process.env[key]]);
    const sharedProxy = createSocks5TunnelServer();
    const sharedProxyPort = await listen(sharedProxy);
    for (const key of envKeys) process.env[key] = `socks5://127.0.0.1:${sharedProxyPort}`;

    try {
      await expect(proxyAwareFetch(`http://127.0.0.1:${targetPort}/probe`, {
        method: "GET",
      }, { strictProxy: true, requireAccountProxy: true })).rejects.toThrow(/no connection proxy is configured/);
      expect(directRequests).toBe(0);
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects account-isolated requests that match noProxy instead of bypassing", async () => {
    let directRequests = 0;
    const target = http.createServer((_req, res) => {
      directRequests++;
      res.end("direct");
    });
    const targetPort = await listen(target);
    const socks = createSocks5TunnelServer();
    const proxyPort = await listen(socks);

    await expect(proxyAwareFetch(`http://127.0.0.1:${targetPort}/probe`, {
      method: "GET",
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: `socks5://127.0.0.1:${proxyPort}`,
      connectionNoProxy: "127.0.0.1",
      strictProxy: true,
      requireAccountProxy: true,
    })).rejects.toThrow(/target matches noProxy/);

    expect(directRequests).toBe(0);
  });

  it("fails closed instead of silently going direct when a strict SOCKS proxy is down", async () => {
    let directRequests = 0;
    const target = http.createServer((_req, res) => {
      directRequests++;
      res.end("direct");
    });
    const targetPort = await listen(target);
    const closedProxy = net.createServer();
    const proxyPort = await listen(closedProxy);
    await close(closedProxy);

    await expect(proxyAwareFetch(`http://127.0.0.1:${targetPort}/probe`, {
      method: "GET",
    }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: `socks5://127.0.0.1:${proxyPort}`,
      strictProxy: true,
      requireAccountProxy: true,
    })).rejects.toThrow(/SOCKS5 proxy required but failed/);

    expect(directRequests).toBe(0);
  });
});
