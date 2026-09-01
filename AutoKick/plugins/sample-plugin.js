export default {
  name: "AutoKick Sample Plugin",
  version: "0.1.0",
  actions: {
    announce: async ({ api, placeholders }) => {
      await api.chat(`Hello ${placeholders?.me ?? "player"}!`);
    },
  },
};