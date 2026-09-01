class Player {
    constructor(player) {
        this.player = player;

        player.on("clientbound", async ({ name, params }, des) => {
            console.log(name, "clientbound")
        })

        player.on("serverbound", async ({ name, params }, des) => {
            console.log(name, "serverbound")
        })

        player.on("error", (error) => {
            console.log(error);
        });
    }
}

module.exports = Player;