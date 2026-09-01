const { Authflow, Titles } = require("prismarine-auth");

class XboxAPI {
    constructor() { }

    async getXboxToken(relyingParty) {
        let flow = new Authflow(undefined, "./auth", {
            flow: "sisu",
            authTitle: Titles.MinecraftIOS,
            deviceType: "iOS",
        }, (data) => {
            console.log(`${data.message}`);
        });

        let xboxToken = await flow.getXboxToken(relyingParty);

        if (typeof xboxToken.userXUID === "string" || typeof xboxToken.userXUID === "number") this.xuid = xboxToken?.userXUID;

        return `XBL3.0 x=${xboxToken.userHash};${xboxToken.XSTSToken}`;
    }

    async sendPresence(body) {
        const authToken = await this.getXboxToken();
        if (!authToken) return

        if (authToken?.errorMsg) return authToken;

        body = JSON.stringify(body);

        const response = await fetch(`https://userpresence.xboxlive.com/users/xuid(${this.xuid})/devices/current/titles/current`, {
            method: "POST",
            headers: {
                "x-xbl-contract-version": 3,
                "Accept-Encoding": "gzip, deflate",
                "Accept": "application/json",
                "Accept-Language": "en-US",
                "Content-Length": body.length,
                "Authorization": authToken,
                "Content-Type": "application/json; charset=UTF-8",
                "Host": "userpresence.xboxlive.com",
                "Connection": "Keep-Alive",
                "Cache-Control": "no-cache"
            },
            body
        });

        switch (response.status) {
            case 200:
                return "success";
            default:
                return { errorMsg: await response.text(), status: response.status };
        }
    }

    async sendInGamePresence(realm, inGame) {
        const authToken = await this.getXboxToken();
        if (!authToken) return

        if (authToken?.errorMsg) return authToken;

        const response = await fetch(`https://clubpresence.xboxlive.com/clubs/${realm.clubId}/users/xuid(${this.xuid})/session?titleFamilyId=3347393a-1a27-4e26-a623-31173bb86ee1`, {
            method: "POST",
            headers: {
                "Accept-Language": "en-US",
                "Authorization": authToken,
                "Content-Type": "application/json",
                "User-Agent": "libhttpclient/1.0.0.0",
                "x-xbl-contract-version": "1",
                "Accept-Encoding": "gzip, deflate, br",
                "Host": "clubpresence.xboxlive.com",
                "Connection": "Keep-Alive",
                "Cache-Control": "no-cache"
            },
            body: JSON.stringify({ inGame })
        });

        switch (response.status) {
            case 204:
                return "success";
            default:
                return { errorMsg: await response.text(), status: response.status };
        }
    }
}

module.exports = XboxAPI;