const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const Sequelize = require('sequelize');
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { id } = req.params;
    const { profile } = req;


    // Find the contract by ID
    const contract = await Contract.findOne({ where: { id } });

    if (!contract) {
        return res.status(404).end();  // Contract not found
    }


    // Check if the authenticated profile is the client or contractor of the contract
    if (contract.ClientId !== profile.id && contract.ContractorId !== profile.id) {
        return res.status(403).end();  // Forbidden
    }


    // Return the contract if the profile is authorized
    res.json(contract);
});
// Fetch all non-terminated contracts belonging to the authenticated user
app.get('/contracts', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { profile } = req;


    try {
        // Find all contracts where the profile is either the client or contractor
        const contracts = await Contract.findAll({
            where: {
                [Sequelize.Op.or]: [
                    { ClientId: profile.id },
                    { ContractorId: profile.id }
                ],
                status: {
                    [Sequelize.Op.not]: 'terminated' // Exclude terminated contracts
                }
            }
        });


        // Return the list of contracts
        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Fetch all unpaid jobs for a user (client or contractor) where contracts are active
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get('models');
    const { profile } = req;


    try {
        // Find all unpaid jobs where the profile is either the client or contractor and the contract is active
        const unpaidJobs = await Job.findAll({
            include: [{
                model: Contract,
                where: {
                    [Sequelize.Op.or]: [
                        { ClientId: profile.id },
                        { ContractorId: profile.id }
                    ],
                    status: 'in_progress' // Only consider active contracts
                }
            }],
            where: {
                [Sequelize.Op.or]: [{paid: false}, {paid: null}] // Include legacy null unpaid values
            }
        });


        // Return the list of unpaid jobs
        res.json(unpaidJobs);
    } catch (error) {
        console.error('Error fetching unpaid jobs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// BEGIN IMMEDIATE serializes SQLite balance changes before reading mutable state.
function paymentError(status, message) { return Object.assign(new Error(message), {status}); }
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const {Job, Contract, Profile} = req.app.get('models');
    try {
        await sequelize.transaction({type: Sequelize.Transaction.TYPES.IMMEDIATE}, async transaction => {
            const job = await Job.findOne({where: {id: req.params.job_id}, include: [{model: Contract, where: {ClientId: req.profile.id}}], transaction});
            if (!job) throw paymentError(404, 'Job not found or not authorized.');
            if (job.paid) throw paymentError(400, 'Job has already been paid.');
            const client = await Profile.findByPk(req.profile.id, {transaction});
            const contractor = await Profile.findByPk(job.Contract.ContractorId, {transaction});
            const price = Number(job.price);
            if (!client || !contractor || !Number.isFinite(price) || price <= 0) throw paymentError(400, 'Invalid payment.');
            if (!Number.isFinite(Number(client.balance)) || Number(client.balance) < price) throw paymentError(400, 'Insufficient balance.');
            await client.decrement('balance', {by: price, transaction});
            await contractor.increment('balance', {by: price, transaction});
            job.paid = true;
            job.paymentDate = new Date();
            await job.save({transaction});
        });
        res.json({message: 'Payment successful.'});
    } catch (error) {
        res.status(error.status || 500).json({error: error.status ? error.message : 'Failed to process payment.'});
    }
});

app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const {Profile, Job, Contract} = req.app.get('models');
    const {amount} = req.body;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({error: 'Amount must be a positive finite number.'});
    }
    if (String(req.profile.id) !== req.params.userId) return res.status(403).json({error: 'You can only deposit into your own account.'});
    if (req.profile.type !== 'client') return res.status(400).json({error: 'Only clients can deposit money.'});
    try {
        const newBalance = await sequelize.transaction({type: Sequelize.Transaction.TYPES.IMMEDIATE}, async transaction => {
            const jobs = await Job.findAll({include: [{model: Contract, where: {ClientId: req.profile.id, status: 'in_progress'}}], where: {[Sequelize.Op.or]: [{paid: false}, {paid: null}]}, transaction});
            const total = jobs.reduce((sum, job) => sum + Number(job.price), 0);
            if (!Number.isFinite(total) || amount > total * 0.25) throw paymentError(400, 'Deposit exceeds 25% of unpaid jobs.');
            const client = await Profile.findByPk(req.profile.id, {transaction});
            if (!client || !Number.isFinite(Number(client.balance))) throw paymentError(400, 'Invalid account balance.');
            await client.increment('balance', {by: amount, transaction});
            await client.reload({transaction});
            return Number(client.balance);
        });
        res.json({message: 'Deposit successful.', newBalance});
    } catch (error) {
        res.status(error.status || 500).json({error: error.status ? error.message : 'Failed to deposit.'});
    }
});

app.get('/admin/best-profession', async (req, res) => {
    const { start, end } = req.query;
    const { Profile } = req.app.get('models');
    try {
        // Validate date inputs
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required.' });
        }

        // Convert start and end dates to the appropriate format
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Execute raw SQL query using sequelize.query
        const bestProfession = await sequelize.query(
            `SELECT Profile.profession, SUM(Jobs.price) AS totalEarnings
             FROM Profiles AS Profile
             INNER JOIN Contracts AS Contractor ON Contractor.ContractorId = Profile.id
             INNER JOIN Jobs ON Jobs.ContractId = Contractor.id
             WHERE Jobs.paid = 1 AND Jobs.paymentDate BETWEEN :startDate AND :endDate
             GROUP BY Profile.profession
             ORDER BY totalEarnings DESC
             LIMIT 1`,
            {
                replacements: { startDate, endDate },
                type: Sequelize.QueryTypes.SELECT,
                model: Profile,
                mapToModel: true // Map the results to the Profile model
            }
        );

        if (!bestProfession || bestProfession.length === 0) {
            return res.status(404).json({ error: 'No profession found for the given date range.' });
        }

        res.json(bestProfession[0]);
    } catch (error) {
        console.error('Error fetching best profession:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/admin/best-clients', async (req, res) => {
    const { start, end, limit = 2 } = req.query;

    try {
        // Validate date inputs
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required.' });
        }

        // Convert start and end dates to the appropriate format
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Execute raw SQL query using sequelize.query
        const bestClients = await sequelize.query(
            `SELECT Profile.id, 
                    Profile.firstName || ' ' || Profile.lastName AS fullName, 
                    SUM(Jobs.price) AS paid
             FROM Profiles AS Profile
             INNER JOIN Contracts AS Contract ON Contract.ClientId = Profile.id
             INNER JOIN Jobs ON Jobs.ContractId = Contract.id
             WHERE Jobs.paid = 1 AND Jobs.paymentDate BETWEEN :startDate AND :endDate
             GROUP BY Profile.id
             ORDER BY paid DESC
             LIMIT :limit`,
            {
                replacements: { startDate, endDate, limit: parseInt(limit, 10) },
                type: Sequelize.QueryTypes.SELECT
            }
        );

        res.json(bestClients);
    } catch (error) {
        console.error('Error fetching best clients:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = app;
