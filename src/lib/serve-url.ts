import type { NetworkInterfaceInfo } from "node:os";
import { networkInterfaces } from "node:os";

interface ServeUrlOptions {
  listenHost: string;
  listenPort: number;
  protocol?: "http" | "https";
  appendOpenUrlCredentials?: (url: URL) => void;
  interfacesByName?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface ServeUrls {
  localUrl: string;
  localOpenUrl: string;
  networkUrl?: string;
  networkOpenUrl?: string;
}

interface NetworkCandidate {
  address: string;
  interfaceName: string;
}

export function getServeUrls(options: ServeUrlOptions): ServeUrls {
  const localHost = options.listenHost === "0.0.0.0" ? "127.0.0.1" : options.listenHost;
  const protocol = options.protocol ?? "http";
  const networkHost =
    options.listenHost === "0.0.0.0"
      ? pickLocalNetworkHost(options.interfacesByName ?? networkInterfaces())
      : undefined;

  return {
    localUrl: buildServeUrl(protocol, localHost, options.listenPort),
    localOpenUrl: buildOpenUrl(
      protocol,
      localHost,
      options.listenPort,
      options.appendOpenUrlCredentials,
    ),
    networkUrl: networkHost ? buildServeUrl(protocol, networkHost, options.listenPort) : undefined,
    networkOpenUrl: networkHost
      ? buildOpenUrl(protocol, networkHost, options.listenPort, options.appendOpenUrlCredentials)
      : undefined,
  };
}

function buildServeUrl(protocol: "http" | "https", host: string, port: number): string {
  return `${protocol}://${host}:${port}/`;
}

function buildOpenUrl(
  protocol: "http" | "https",
  host: string,
  port: number,
  appendOpenUrlCredentials?: (url: URL) => void,
): string {
  const url = new URL(buildServeUrl(protocol, host, port));
  appendOpenUrlCredentials?.(url);
  return url.toString();
}

function pickLocalNetworkHost(
  interfacesByName: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | undefined {
  const candidates = Object.entries(interfacesByName).flatMap(([interfaceName, infos]) =>
    (infos ?? [])
      .filter((info) => info.family === "IPv4" && !info.internal && Boolean(info.address))
      .map((info) => ({
        address: info.address,
        interfaceName,
      })),
  );

  candidates.sort((left, right) => {
    const scoreDifference = scoreNetworkCandidate(right) - scoreNetworkCandidate(left);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    const nameDifference = left.interfaceName.localeCompare(right.interfaceName);
    if (nameDifference !== 0) {
      return nameDifference;
    }
    return left.address.localeCompare(right.address);
  });

  return candidates[0]?.address;
}

function scoreNetworkCandidate(candidate: NetworkCandidate): number {
  let score = 0;
  if (isPrivateIpv4(candidate.address)) {
    score += 10;
  }
  if (/^(en|eth|wlan|wifi|wi-fi)/i.test(candidate.interfaceName)) {
    score += 3;
  }
  if (/^(utun|tun|tap|tailscale|wg|docker|veth|lo)/i.test(candidate.interfaceName)) {
    score -= 5;
  }
  return score;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((segment) => Number.parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
