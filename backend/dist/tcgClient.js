export class TcgClient {
    apiKey;
    baseUrl;
    constructor(options) {
        this.apiKey = options.apiKey;
        this.baseUrl = options.baseUrl;
    }
    async searchByName(name) {
        const url = new URL("/v2/cards", this.baseUrl);
        url.searchParams.set("q", `name:\"${name}\"`);
        url.searchParams.set("pageSize", "8");
        const headers = {};
        if (this.apiKey.trim()) {
            headers["X-Api-Key"] = this.apiKey.trim();
        }
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`TCG API error ${response.status}`);
        }
        return response.json();
    }
}
