import { v2 as cloudinary } from "cloudinary";
import { configDotenv } from "dotenv";
import fs from "fs";
configDotenv()




// Configuration
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_API_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET
});


// `folder` is optional and backward compatible: every existing call site may
// keep passing only the local path, in which case nothing changes.
const uploadOnCloudinary = async (localFilePath, folder) => {
    try {
        if(!localFilePath) return null;

        const response = await cloudinary.uploader.upload(
            localFilePath,
            {resource_type : "auto", ...(folder ? { folder } : {})}
        );
        console.log("Upload was successful, public_id : ", response?.public_id);
        
        fs.unlinkSync(localFilePath) // upload done so remove temp file

        return response;

    } catch (error) {
        fs.unlinkSync(localFilePath) // delete file in case of error
        console.log("src > utils > cloudinary.js {uploadOnCloudinary} : ", error)
        return null;
    }
};


const deleteFileOnCloudinary = async (OldPublicId) => {
    try {
        if(!OldPublicId) return null;

        const response = await cloudinary.uploader.destroy( OldPublicId );

        console.log("old file was deleted : ", response);

        return response;

    } catch (error) {
        console.log("src > utils > cloudinary.js {deleteFileOnCloudinary} : ", error)
        return null;
    }
};




export{ uploadOnCloudinary, deleteFileOnCloudinary };