import mongoose from "mongoose";
import { DB_Name } from "../constance.js";


const ConnectDB = async () => {
    try {
        
        const connectionInstance = await mongoose.connect(`${process.env.MONGODB_URI}/${DB_Name}`);
        console.log(`DB connected successfully 😍👍 Host : ${connectionInstance.connection.host}`);

    } catch (error) {
        console.log("MongoDB connection Error src > db > index.js ", error);
        process.exit(1);
    }
}

// paired with ConnectDB so a shutdown closes the pool instead of killing the
// process mid-write; mongoose is a module-level singleton, so one call is enough
const DisconnectDB = async () => {
    try {
        await mongoose.disconnect();
        console.log("DB disconnected");
    } catch (error) {
        console.log("MongoDB disconnect Error src > db > index.js ", error);
    }
}

export{ConnectDB, DisconnectDB}
