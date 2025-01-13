import mongoose from "mongoose";

const Atlas = mongoose.createConnection(
  `mongodb+srv://${Bun.env.DB_USER}:${Bun.env.DB_PASS}@${Bun.env.DB_CLUSTER}/main?retryWrites=true&w=majority&appName=Cluster0` as string,
);
Atlas.on("connected", () => console.log("Connected to Atlas Database"));

export default Atlas;
