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
    })).rejects.toThrow(/SOCKS5 proxy required but failed/);

    expect(directRequests).toBe(0);
  });
});
