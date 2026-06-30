export type PokeWalletClientOptions = {
  apiKey: string;
  baseUrl: string;
};

export class PokeWalletClient {
  apiKey: string;
  baseUrl: string;

  constructor(options: PokeWalletClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  async searchByName(name: string): Promise<unknown> {
    if (!this.apiKey.trim()) {
      throw new Error("PokeWallet API key is required");
    }

    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", name.trim());

    const response = await fetch(url, {
      headers: {
        "X-API-Key": this.apiKey.trim(),
        "Authorization": `Bearer ${this.apiKey.trim()}`
      }
    });

    if (!response.ok) {
      throw new Error(`PokeWallet API error ${response.status}`);
    }

    return response.json();
  }

  async getCardImage(cardId: string, size: "low" | "high" = "high"): Promise<Response> {
    if (!this.apiKey.trim()) {
      throw new Error("PokeWallet API key is required");
    }

    const url = new URL(`/images/${encodeURIComponent(cardId.trim())}`, this.baseUrl);
    url.searchParams.set("size", size);

    const response = await fetch(url, {
      headers: {
        "X-API-Key": this.apiKey.trim(),
        "Authorization": `Bearer ${this.apiKey.trim()}`
      }
    });

    if (!response.ok) {
      throw new Error(`PokeWallet image error ${response.status}`);
    }

    return response;
  }
}
