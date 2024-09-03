
const getProfile = async (req, res, next) => {
    try {
        const { Profile } = req.app.get('models');
        const profileId = req.get('profile_id');

        // Ensure profile_id is provided
        if (!profileId) {
            return res.status(400).json({ error: 'Profile ID is required in the request header.' });
        }

        // Fetch the profile from the database
        const profile = await Profile.findOne({ where: { id: profileId } });

        // If no profile is found, return a 401 Unauthorized response
        if (!profile) {
            return res.status(401).json({ error: 'Unauthorized: Profile not found.' });
        }

        // Attach the profile to the request object
        req.profile = profile;

        // Proceed to the next middleware or route handler
        next();
    } catch (error) {
        console.error('Error in getProfile middleware:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { getProfile };

